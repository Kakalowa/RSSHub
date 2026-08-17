import querystring from 'node:querystring';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { Route } from '@/types';
import got from '@/utils/got';

export const route: Route = {
    path: '/followings/dynamic/comments/:uid/:type/:oid/:routeParams?',
    categories: ['social-media'],
    example: '/bilibili/followings/dynamic/comments/2267573/17/123456789',
    parameters: {
        uid: '用于关注动态 Cookie 的用户 id',
        type: 'Bilibili 评论区类型',
        oid: '评论区 oid',
        routeParams: `
| 键  | 含义                 | 接受的值   | 默认值 |
| --- | -------------------- | ---------- | ------ |
| page | 评论页码            | 1–1000     | 1      |
| root | 顶层评论 rpid，提供时加载楼中楼 | 数字字符串 | 无 |`,
    },
    features: {
        requireConfig: [
            {
                name: 'BILIBILI_COOKIE_*',
                description: 'BILIBILI_COOKIE_{uid}: 对应 uid 的 Bilibili 登录 Cookie。',
            },
        ],
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: '关注动态评论分页',
    maintainers: ['TigerCubDen', 'JimenezLi'],
    handler,
    description: '供关注动态客户端按需加载顶层评论和楼中楼回复。提供 `root` 时加载该评论的回复。',
};

const PAGE_SIZE = 10;

function escapeHtml(text: string) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function safeImageUrl(value: unknown) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return;
    }
    try {
        const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return;
        }
        url.protocol = 'https:';
        return url.href;
    } catch {
        return;
    }
}

function serializeEmotes(content) {
    if (!content?.emote || typeof content.emote !== 'object') {
        return [];
    }
    return Object.entries(content.emote).flatMap(([token, emote]) => {
        const data = emote as { gif_url?: unknown; meta?: { size?: unknown }; url?: unknown };
        const url = safeImageUrl(data.gif_url || data.url);
        return url ? [{ token, url, large: Number(data.meta?.size) === 2 }] : [];
    });
}

function serializeComment(reply) {
    return {
        id: String(reply.rpid_str ?? reply.rpid ?? ''),
        author: String(reply.member?.uname ?? '匿名'),
        text: String(reply.content?.message ?? ''),
        likes: Math.max(0, Number(reply.like ?? 0)),
        createdAt: Number(reply.ctime ?? 0) * 1000,
        replyCount: Math.max(0, Number(reply.rcount ?? 0)),
        emotes: serializeEmotes(reply.content),
    };
}

async function handler(ctx) {
    const uid = String(ctx.req.param('uid'));
    const type = String(ctx.req.param('type'));
    const oid = String(ctx.req.param('oid'));
    const routeParams = querystring.parse(ctx.req.param('routeParams'));
    const root = String(routeParams.root ?? ctx.req.query('root') ?? '').trim();
    const requestedPage = Math.trunc(Number(routeParams.page ?? ctx.req.query('page') ?? '1'));
    const page = Number.isFinite(requestedPage) ? Math.min(Math.max(requestedPage, 1), 1000) : 1;

    if (!/^\d{1,10}$/.test(type) || !/^\d{1,32}$/.test(oid) || (root && !/^\d{1,32}$/.test(root))) {
        throw new Error('Invalid Bilibili comment parameters');
    }

    const cookie = config.bilibili.cookies[uid];
    if (cookie === undefined) {
        throw new ConfigNotFoundError('缺少对应 uid 的 Bilibili 用户登录后的 Cookie 值');
    }

    const response = await got({
        method: 'get',
        url: root ? 'https://api.bilibili.com/x/v2/reply/reply' : 'https://api.bilibili.com/x/v2/reply',
        searchParams: {
            type,
            oid,
            pn: String(page),
            ps: String(PAGE_SIZE),
            ...(root ? { root } : { sort: '0' }),
        },
        headers: {
            Referer: 'https://t.bilibili.com/',
            Cookie: cookie,
        },
    });

    if (response.data?.code !== 0) {
        throw new Error(`Bilibili comments API request failed: ${response.data?.code} ${response.data?.message}`);
    }

    const data = response.data?.data;
    const replies = data?.replies ?? [];
    const total = Math.max(0, Number(data?.page?.count ?? data?.cursor?.all_count ?? replies.length));
    const hasMore = replies.length > 0 && (page * PAGE_SIZE < total || (total === 0 && replies.length === PAGE_SIZE));
    const nextPage = hasMore ? page + 1 : undefined;
    const link = 'https://t.bilibili.com/';

    return {
        title: root ? `评论 ${root} 的回复` : `动态评论 ${oid}`,
        link,
        description: root ? 'Bilibili 动态评论的楼中楼回复' : 'Bilibili 动态评论',
        item: replies.map((reply, index) => {
            const comment = serializeComment(reply);
            return {
                title: `${comment.author}: ${comment.text}`,
                description: escapeHtml(`${comment.author}: ${comment.text}`),
                pubDate: comment.createdAt ? new Date(comment.createdAt).toUTCString() : undefined,
                link: `${link}#reply${comment.id}`,
                _extra: {
                    bilibiliComment: comment,
                    ...(index === replies.length - 1 && nextPage && { bilibiliNextCommentPage: nextPage }),
                },
            };
        }),
    };
}
