import { Handler } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

interface Agg {
  total: number
  byTool: Record<string, number>
  users: string[]
  byDay: Record<string, number>
}

export const handler: Handler = async (req) => {
  // 简单的私有看板保护：若部署时设置了环境变量 STATS_KEY，则必须带 ?key=xxx
  const expected = process.env.STATS_KEY
  const key = req.queryStringParameters?.key
  if (expected && key !== expected) {
    return { statusCode: 401, body: 'Unauthorized' }
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
    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify(out),
    }
  } catch (e) {
    console.error('stats error', e)
    return { statusCode: 500, body: 'Internal Error' }
  }
}
