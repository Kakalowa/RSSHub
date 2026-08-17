import querystring from 'node:querystring';

import JSONbig from 'json-bigint';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { Route } from '@/types';
import got from '@/utils/got';
import logger from '@/utils/logger';
import { fallback, queryToBoolean } from '@/utils/readable-social';

import cache from './cache';
import utils from './utils';

export const route: Route = {
    path: '/followings/dynamic/:uid/:routeParams?',
    categories: ['social-media'],
    example: '/bilibili/followings/dynamic/109937383',
    parameters: {
        uid: '用户 id, 可在 UP 主主页中找到',
        routeParams: `
| 键         | 含义                              | 接受的值       | 默认值 |
| ---------- | --------------------------------- | -------------- | ------ |
| showEmoji  | 显示或隐藏表情图片                | 0/1/true/false | false  |
| embed      | 默认开启内嵌视频                  | 0/1/true/false |  true  |
| useAvid    | 视频链接使用 AV 号 (默认为 BV 号) | 0/1/true/false | false  |
| directLink | 使用内容直链                      | 0/1/true/false | false  |
| hideGoods  | 隐藏带货动态                      | 0/1/true/false | false  |
| includeVideos | 包含视频类动态                 | 0/1/true/false | false  |

用例：\`/bilibili/followings/dynamic/2267573/showEmoji=1&embed=0&useAvid=1\``,
    },
    features: {
        requireConfig: [
            {
                name: 'BILIBILI_COOKIE_*',
                description: `BILIBILI_COOKIE_{uid}: 用于用户关注动态系列路由，对应 uid 的 b 站用户登录后的 Cookie 值，\`{uid}\` 替换为 uid，如 \`BILIBILI_COOKIE_2267573\`，获取方式：
    1.  打开 [https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/dynamic_new?uid=0&type=8](https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/dynamic_new?uid=0&type=8)
    2.  打开控制台，切换到 Network 面板，刷新
    3.  点击 dynamic_new 请求，找到 Cookie
    4.  复制整段 Cookie，删掉其中的 \`bili_ticket\` 和 \`bili_ticket_expires\` 字段来延长有效期`,
            },
        ],
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: '用户关注动态',
    maintainers: ['TigerCubDen', 'JimenezLi'],
    handler,
    description: `::: warning
用户动态需要 b 站登录后的 Cookie 值，所以只能自建，详情见部署页面的配置模块。
:::`,
};

const DEFAULT_COMMENT_LIMIT = 10;
const MAX_COMMENT_LIMIT = 20;
const TARGET_ITEMS = 20;
const MAX_DYNAMIC_PAGES = 20;

const VIDEO_DYNAMIC_TYPES = new Set([8, 16, 32, 512]);

const COMMENT_TYPE_BY_DYNAMIC_TYPE: Record<number, number> = {
    2: 11,
    8: 1,
    16: 5,
    64: 12,
    256: 14,
};

type DynamicCard = {
    card: string;
    desc: {
        dynamic_id?: unknown;
        dynamic_id_str?: string;
        rid?: unknown;
        rid_str?: string;
        timestamp: number;
        type?: number;
        user_profile?: {
            info: {
                face?: string;
                uname: string;
            };
        };
    };
    display?: {
        emoji_info?: {
            emoji_details: Array<{
                text: string;
                url: string;
            }>;
        };
    };
};

function escapeHtml(text: string) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function normalizeImageUrl(value: unknown) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return '';
    }
    try {
        const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return '';
        }
        url.protocol = 'https:';
        return url.href;
    } catch {
        return '';
    }
}

function safeImageUrl(value: unknown) {
    const url = normalizeImageUrl(value);
    return url ? escapeHtml(url) : '';
}

function renderCommentMessage(reply) {
    let message = escapeHtml(String(reply.content?.message ?? ''));
    const emotes = reply.content?.emote;
    if (emotes && typeof emotes === 'object') {
        for (const [token, emote] of Object.entries(emotes)) {
            const data = emote as { gif_url?: unknown; meta?: { size?: unknown }; url?: unknown };
            const url = safeImageUrl(data.gif_url || data.url);
            if (!url) {
                continue;
            }
            const escapedToken = escapeHtml(token);
            const size = Number(data.meta?.size) === 2 ? 'large' : 'inline';
            message = message.replaceAll(escapedToken, () => `<img alt="${escapedToken}" data-bilibili-emote="${size}" src="${url}">`);
        }
    }
    return message.replaceAll('\n', '<br>');
}

function isVideoDynamic(item: DynamicCard) {
    return VIDEO_DYNAMIC_TYPES.has(Number(item.desc?.type));
}

async function getDynamicComments(oid: string, type: number, dynamicId: string, cookie: string, limit: number) {
    if (!oid || limit <= 0) {
        return { html: '', loaded: true, selectedCount: 0, total: 0 };
    }

    try {
        const response = await got({
            method: 'get',
            url: 'https://api.bilibili.com/x/v2/reply',
            searchParams: {
                type: String(type),
                oid,
                sort: '0',
                pn: '1',
                ps: String(limit),
            },
            headers: {
                Referer: `https://t.bilibili.com/${dynamicId}`,
                Cookie: cookie,
            },
        });

        if (response.data?.code !== 0) {
            logger.warn(`[bilibili/followings/dynamic] failed to fetch comments for type ${type}, oid ${oid}: ${response.data?.code} ${response.data?.message}`);
            return { html: '', loaded: false, selectedCount: 0, total: 0 };
        }

        const replyData = response.data?.data;
        const replies = replyData?.replies?.length ? replyData.replies : (replyData?.hots ?? []);
        const selected = replies.slice(0, limit);
        const total = Number(replyData?.page?.count ?? replyData?.cursor?.all_count ?? selected.length);

        if (selected.length === 0) {
            return { html: '', loaded: true, selectedCount: 0, total };
        }

        const html = selected
            .map((reply, index) => {
                const username = escapeHtml(String(reply.member?.uname ?? '匿名'));
                const message = renderCommentMessage(reply);
                const likes = Number(reply.like ?? 0);
                const commentId = String(reply.rpid_str ?? reply.rpid ?? '');
                const replyCount = Math.max(0, Number(reply.rcount ?? 0));

                return `
                    <div data-bilibili-comment-id="${escapeHtml(commentId)}" data-bilibili-reply-count="${replyCount}" style="margin: 0.8em 0;">
                        <b>${index + 1}. ${username}</b>
                        ${likes > 0 ? ` · 👍 ${likes}` : ''}
                        <br>
                        ${message}
                    </div>
                `;
            })
            .join('');

        return { html: `<hr><h3>评论（前 ${selected.length} 条）</h3>${html}`, loaded: true, selectedCount: selected.length, total };
    } catch (error) {
        logger.warn(`[bilibili/followings/dynamic] failed to fetch comments for type ${type}, oid ${oid}: ${error}`);
        return { html: '', loaded: false, selectedCount: 0, total: 0 };
    }
}

async function handler(ctx) {
    const uid = String(ctx.req.param('uid'));
    const requestedCommentLimit = Math.trunc(Number(ctx.req.query('comments') ?? String(DEFAULT_COMMENT_LIMIT)));
    const requestedOffset = String(ctx.req.query('offset') ?? '').trim();

    if (requestedOffset && !/^\d{1,32}$/.test(requestedOffset)) {
        throw new Error('Invalid Bilibili dynamic offset');
    }

    const commentLimit = Number.isFinite(requestedCommentLimit) ? Math.min(Math.max(requestedCommentLimit, 0), MAX_COMMENT_LIMIT) : DEFAULT_COMMENT_LIMIT;
    const routeParams = querystring.parse(ctx.req.param('routeParams'));

    const showEmoji = fallback(undefined, queryToBoolean(routeParams.showEmoji), false);
    const embed = fallback(undefined, queryToBoolean(routeParams.embed), true);
    const includeVideos = fallback(undefined, queryToBoolean(routeParams.includeVideos), false);
    const displayArticle = fallback(undefined, queryToBoolean(routeParams.displayArticle), false);

    const name = await cache.getUsernameFromUID(uid);
    const cookie = config.bilibili.cookies[uid];
    if (cookie === undefined) {
        throw new ConfigNotFoundError('缺少对应 uid 的 Bilibili 用户登录后的 Cookie 值');
    }

    const getDynamicPage = async (offset = '') => {
        const isHistoryPage = Boolean(offset);
        const response = await got({
            method: 'get',
            url: `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/${isHistoryPage ? 'dynamic_history' : 'dynamic_new'}`,
            searchParams: {
                uid,
                type_list: '268435455',
                ...(isHistoryPage && { offset_dynamic_id: offset }),
            },
            headers: {
                Referer: `https://space.bilibili.com/${uid}/`,
                Cookie: cookie,
            },
        });
        const body = JSONbig.parse(response.body);
        if (body.code === -6) {
            throw new ConfigNotFoundError('对应 uid 的 Bilibili 用户的 Cookie 已过期');
        }
        if (body.code === 4_100_000) {
            throw new ConfigNotFoundError('对应 uid 的 Bilibili 用户 请求失败');
        }
        if (body.code !== 0) {
            throw new Error(`Bilibili dynamic API request failed: ${body.code} ${body.message}`);
        }
        return body.data;
    };

    const data: DynamicCard[] = [];
    const seenDynamicIds = new Set<string>();
    const appendCards = (cards: DynamicCard[] = []) => {
        for (const item of cards) {
            const dynamicId = String(item.desc?.dynamic_id_str ?? item.desc?.dynamic_id ?? '');
            if (dynamicId && seenDynamicIds.has(dynamicId)) {
                continue;
            }
            if (dynamicId) {
                seenDynamicIds.add(dynamicId);
            }
            if (includeVideos || !isVideoDynamic(item)) {
                data.push(item);
            }
        }
    };

    let dynamicPage = await getDynamicPage(requestedOffset);
    appendCards(dynamicPage.cards);

    let offset = String((requestedOffset ? dynamicPage.next_offset : dynamicPage.history_offset) ?? '');
    let hasMore = requestedOffset ? Boolean(dynamicPage.has_more && offset) : Boolean(offset);
    let pageCount = 1;
    while (data.length < TARGET_ITEMS && hasMore && pageCount < MAX_DYNAMIC_PAGES) {
        const previousOffset = offset;
        // eslint-disable-next-line no-await-in-loop -- the next history cursor comes from the previous page
        dynamicPage = await getDynamicPage(offset);
        pageCount++;
        appendCards(dynamicPage.cards);

        offset = String(dynamicPage.next_offset ?? '');
        hasMore = Boolean(dynamicPage.has_more && offset && offset !== previousOffset);
        if (!hasMore) {
            break;
        }
    }

    if (data.length < TARGET_ITEMS) {
        logger.warn(`[bilibili/followings/dynamic] only found ${data.length} ${includeVideos ? '' : 'non-video '}dynamics after ${pageCount} page(s)`);
    }

    const getTitle = (data) => (data ? data.title || data.description || data.content || (data.vest && data.vest.content) || '' : '');
    const getDes = (data) =>
        data.dynamic || data.desc || data.description || data.content || data.summary || (data.vest && data.vest.content) + (data.sketch && `<br>${data.sketch.title}<br>${data.sketch.desc_text}`) || data.intro || '';
    const getOriginDes = (data) => (data && (data.apiSeasonInfo && data.apiSeasonInfo.title && `//转发自: ${data.apiSeasonInfo.title}`) + (data.index_title && `<br>${data.index_title}`)) || '';
    const getOriginName = (data) => data.uname || (data.author && data.author.name) || (data.upper && data.upper.name) || (data.user && (data.user.uname || data.user.name)) || (data.owner && data.owner.name) || '';
    const getOriginTitle = (data) => (data.title ? `${data.title}<br>` : '');
    const getIframe = (data) => {
        if (!embed) {
            return '';
        }
        const aid = data?.aid;
        const bvid = data?.bvid;
        if (aid === undefined && bvid === undefined) {
            return '';
        }
        return utils.renderUGCDescription(embed, '', '', aid, undefined, bvid);
    };
    const getImgs = (data) => {
        let imgs = '';
        // 动态图片
        if (data.pictures) {
            for (const pic of data.pictures) {
                imgs += `<img src="${pic.img_src}">`;
            }
        }
        // 专栏封面
        if (data.image_urls) {
            for (const url of data.image_urls) {
                imgs += `<img src="${url}">`;
            }
        }
        // 视频封面
        if (data.pic) {
            imgs += `<img src="${data.pic}">`;
        }
        // 音频/番剧/直播间封面/小视频封面
        if (data.cover && data.cover.unclipped) {
            imgs += `<img src="${data.cover.unclipped}">`;
        } else if (data.cover) {
            imgs += `<img src="${data.cover}">`;
        }
        // 专题页封面
        if (data.sketch && data.sketch.cover_url) {
            imgs += `<img src="${data.sketch.cover_url}">`;
        }
        return imgs;
    };

    const nextOffset = hasMore ? offset : '';
    const selectedData = data.slice(0, TARGET_ITEMS);
    const items = await Promise.all(
        selectedData.map(async (item, index) => {
            const parsed = JSONbig.parse(item.card);
            const data = parsed.apiSeasonInfo || (getTitle(parsed.item) ? parsed.item : parsed);
            const dynamicId = String(item.desc?.dynamic_id_str ?? item.desc?.dynamic_id ?? data.dynamic_id ?? '');
            const dynamicType = Number(item.desc?.type);
            const commentType = COMMENT_TYPE_BY_DYNAMIC_TYPE[dynamicType] ?? 17;
            const commentOid = String((commentType === 17 ? (item.desc?.dynamic_id_str ?? item.desc?.dynamic_id) : (item.desc?.rid_str ?? item.desc?.rid)) ?? dynamicId);
            let origin = parsed.origin;
            if (origin) {
                try {
                    origin = JSONbig.parse(origin);
                } catch {
                    logger.warn(`card.origin '${origin}' is not falsy-valued or a JSON string, fall back to unparsed value`);
                }
            }

            // img
            let imgHTML = '';

            imgHTML += getImgs(data);

            if (origin) {
                imgHTML += getImgs(origin.item || origin);
            }
            // video小视频
            let videoHTML = '';
            if (data.video_playurl) {
                videoHTML += `<video width="${data.width}" height="${data.height}" controls><source src="${unescape(data.video_playurl).replace(/^http:/, 'https:')}"><source src="${unescape(data.video_playurl)}"></video>`;
            }
            // some rss readers disallow http content.
            // 部分 RSS 阅读器要求内容必须使用https传输
            // bilibili short video does support https request, but https request may timeout ocassionally.
            // to maximize content availability, here add two source tags.
            // bilibili的API中返回的视频地址采用http，然而经验证，短视频地址支持https访问，但偶尔会返回超时错误(可能是网络原因)。
            // 因此保险起见加入两个source标签
            // link
            let link = '';
            if (data.dynamic_id) {
                link = `https://t.bilibili.com/${data.dynamic_id}`;
            } else if (item.desc?.dynamic_id) {
                link = `https://t.bilibili.com/${item.desc.dynamic_id}`;
            }

            // emoji
            let data_content = getDes(data);
            if (item.display && item.display.emoji_info && showEmoji) {
                const emoji = item.display.emoji_info.emoji_details;
                for (const item of emoji) {
                    data_content = data_content.replaceAll(
                        new RegExp(`\\${item.text}`, 'g'),
                        () => `<img alt="${item.text}" src="${item.url}"style="margin: -1px 1px 0px; display: inline-block; width: 20px; height: 20px; vertical-align: text-bottom;" title="">`
                    );
                }
            }
            // 作者信息
            let author = '';
            let authorAvatar = '';
            if (item.desc?.user_profile) {
                author = item.desc.user_profile.info.uname;
                authorAvatar = normalizeImageUrl(item.desc.user_profile.info.face);
            }

            if (data.image_urls && displayArticle) {
                data_content = (await cache.getArticleDataFromCvid(data.id, uid)).description;
            }
            // 评论
            const comments = await getDynamicComments(commentOid, commentType, dynamicId, cookie, commentLimit);
            const hasMoreComments = comments.total > comments.selectedCount || (!comments.loaded && commentLimit > 0);
            const commentContext = /^\d+$/.test(commentOid)
                ? {
                      oid: commentOid,
                      type: commentType,
                      total: comments.total,
                      ...(hasMoreComments && { nextPage: comments.selectedCount > 0 ? 2 : 1 }),
                  }
                : undefined;

            return {
                title: getTitle(data),
                author: author ? [{ name: author, ...(authorAvatar && { avatar: authorAvatar }) }] : undefined,
                description: (() => {
                    const description = parsed.new_desc || data_content || getDes(data);
                    const originName = origin && getOriginName(origin) ? `<br><br>//转发自: @${getOriginName(origin)}: ${getOriginTitle(origin.item || origin)}${getDes(origin.item || origin)}` : getOriginDes(origin);
                    const imgHTMLSource = imgHTML ? `<br>${imgHTML}` : '';
                    const videoHTMLSource = videoHTML ? `<br>${videoHTML}` : '';

                    return `${description}${originName}${getIframe(data)}${getIframe(origin)}${imgHTMLSource}${videoHTMLSource}${comments.html}`;
                })(),
                pubDate: new Date(item.desc?.timestamp * 1000).toUTCString(),
                link,
                ...((commentContext || (index === selectedData.length - 1 && nextOffset)) && {
                    _extra: {
                        ...(commentContext && { bilibiliCommentContext: commentContext }),
                        ...(index === selectedData.length - 1 && nextOffset && { bilibiliNextOffset: nextOffset }),
                    },
                }),
            };
        })
    );

    return {
        title: `${name} 关注的动态`,
        link: 'https://t.bilibili.com',
        description: `${name} 关注的动态`,
        item: items,
    };
}
