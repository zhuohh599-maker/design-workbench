// Functions v2 写法（export default）
// 注意：@netlify/blobs 必须是较新版本（>=6）才有 getStore 导出，
// 旧版（1.x）会导致 "does not provide an export named 'getStore'" 运行时错误
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
    // 用强一致读取，避免边缘缓存最多 60s 的滞后导致看板“不更新”
    const agg = ((await store.get('agg', { type: 'json', consistency: 'strong' })) as Agg | null) || {
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
      updatedAt: new Date().toISOString(),
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
