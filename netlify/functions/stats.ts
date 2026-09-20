// Functions v2 写法（export default）——v1（export const handler）运行时
// 不注入 Netlify Blobs 环境，getStore 会抛 MissingBlobsEnvironmentError 导致 502
import { getStore } from '@netlify/blobs'

interface Agg {
  total: number
  byTool: Record<string, number>
  users: string[]
  byDay: Record<string, number>
}

export default async (req: Request) => {
  // 简单的私有看板保护：若部署时设置了环境变量 STATS_KEY，则必须带 ?key=xxx
  const expected = process.env.STATS_KEY
  const key = new URL(req.url).searchParams.get('key')
  if (expected && key !== expected) {
    return new Response('Unauthorized', { status: 401 })
  }
  try {
    const store = getStore({ name: 'stats' })
    const agg = ((await store.get('agg', { type: 'json' })) as Agg | null) || {
      total: 0,
      byTool: {},
      users: [],
      byDay: {},
    }
    const out = {
      total: agg.total,
      users: Array.isArray(agg.users) ? agg.users.length : 0,
      byTool: agg.byTool || {},
      byDay: agg.byDay || {},
    }
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    console.error('stats error', e)
    return new Response('Internal Error', { status: 500 })
  }
}
