import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { Route } from '@/types';
import got from '@/utils/got';
import logger from '@/utils/logger';

import cache from './cache';
import utils from './utils';

const DEFAULT_COMMENT_LIMIT = 10;
const MAX_COMMENT_LIMIT = 20;

function escapeHtml(text: string) {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

async function getVideoComments(aid: number, cookie: string, link: string, limit: number) {
    if (limit <= 0) {
        return '';
    }

    try {
        const response = await got({
            method: 'get',
            url: `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=0`,
            headers: {
                Referer: link,
                Cookie: cookie,
            },
        });

        const replies = response.data?.data?.replies ?? [];
        const selected = replies.slice(0, limit);

        if (selected.length === 0) {
            return '<hr><h3>评论</h3><p>暂无评论</p>';
        }

        const html = selected
            .map((reply, index) => {
                const username = escapeHtml(String(reply.member?.uname ?? '匿名'));
                const message = escapeHtml(String(reply.content?.message ?? '')).replaceAll('\n', '<br>');
                const likes = Number(reply.like ?? 0);

                return `
                    <div style="margin: 0.8em 0;">
                        <b>${index + 1}. ${username}</b>${likes > 0 ? ` · 👍 ${likes}` : ''}
                        <br>
                        ${message}
                    </div>
                `;
            })
            .join('');

        return `<hr><h3>评论（前 ${selected.length} 条）</h3>${html}`;
    } catch (error) {
        logger.warn(`[bilibili/followings/video] failed to fetch comments for aid=${aid}: ${error}`);
        return '';
    }
}

export const route: Route = {
    path: '/followings/video/:uid/:embed?',
    categories: ['social-media'],
    example: '/bilibili/followings/video/2267573',
    parameters: { uid: '用户 id', embed: '默认为开启内嵌视频，任意值为关闭' },
    features: {
        requireConfig: [
            {
                name: 'BILIBILI_COOKIE_*',
                description: `BILIBILI_COOKIE_{uid}: 用于用户关注动态系列路由，对应 uid 的 b 站用户登录后的 Cookie 值，\`{uid}\` 替换为 uid，如 \`BILIBILI_COOKIE_2267573\`，获取方式：
    1.  打开 [https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/dynamic_new?uid=0&type=8](https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/dynamic_new?uid=0&type=8)
    2.  打开控制台，切换到 Network 面板，刷新
    3.  点击 dynamic_new 请求，找到 Cookie
    4.  视频和专栏，UP 主粉丝及关注只要求 \`SESSDATA\` 字段，动态需复制整段 Cookie`,
            },
        ],
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: '用户关注视频动态',
    maintainers: ['LogicJake'],
    handler,
    description: `::: warning
用户动态需要 b 站登录后的 Cookie 值，所以只能自建，详情见部署页面的配置模块。
:::`,
};

async function handler(ctx) {
    const uid = String(ctx.req.param('uid'));
    const embed = !ctx.req.param('embed');

    const requestedCommentLimit = Number.parseInt(
        ctx.req.query('comments') ?? String(DEFAULT_COMMENT_LIMIT),
        10
    );

    const commentLimit = Number.isFinite(requestedCommentLimit)
        ? Math.min(Math.max(requestedCommentLimit, 0), MAX_COMMENT_LIMIT)
        : DEFAULT_COMMENT_LIMIT;
    const name = await cache.getUsernameFromUID(uid);

    const cookie = config.bilibili.cookies[uid];
    if (cookie === undefined) {
        throw new ConfigNotFoundError('缺少对应 uid 的 Bilibili 用户登录后的 Cookie 值');
    }

    const response = await got({
        method: 'get',
        url: `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/dynamic_new?uid=${uid}&type=8`,
        headers: {
            Referer: `https://space.bilibili.com/${uid}/`,
            Cookie: cookie,
        },
    });
    const data = response.data;
    if (data.code) {
        logger.error(JSON.stringify(data));
        if (data.code === -6 || data.code === 4_100_000) {
            throw new ConfigNotFoundError('对应 uid 的 Bilibili 用户的 Cookie 已过期');
        }
        throw new Error(`Got error code ${data.code} while fetching: ${data.message}`);
    }
    const cards = data.data.cards;

    const out = await Promise.all(
        cards.map(async (card) => {
            const card_data = JSON.parse(card.card);
    
            const link =
                card_data.pubdate > utils.bvidTime && card.desc.bvid
                    ? `https://www.bilibili.com/video/${card.desc.bvid}`
                    : `https://www.bilibili.com/video/av${card_data.aid}`;
    
            const image = card_data.pic?.replace(/^http:/, 'https:');
    
            const baseDescription = utils.renderUGCDescription(
                embed,
                image,
                card_data.desc,
                card_data.aid,
                undefined,
                card.desc.bvid
            );
    
            const commentsHtml = await getVideoComments(
                card_data.aid,
                cookie,
                link,
                commentLimit
            );
    
            return {
                title: card_data.title,
                description: `${baseDescription}${commentsHtml}`,
                image,
            
                media: image
                    ? {
                          content: {
                              url: image,
                              type: 'image/jpeg',
                          },
                          thumbnail: {
                              url: image,
                          },
                      }
                    : undefined,
            
                pubDate: new Date(card_data.pubdate * 1000).toUTCString(),
                link,
                author: card.desc.user_profile.info.uname,
            };
        })
    );

    return {
        title: `${name} 关注视频动态`,
        link: 'https://t.bilibili.com/?tab=8',
        item: out,
    };
}
