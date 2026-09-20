import { Handler } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

interface Agg {
  total: number
  byTool: Record<string, number>
  users: string[]
  byDay: Record<string, number>
}

const EMPTY: Agg = { total: 0, byTool: {}, users: [], byDay: {} }

export const handler: Handler = async (req) => {
  if (req.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }
  try {
    const data = JSON.parse(req.body || '{}') as {
      type?: string
      tool?: string
      uid?: string
    }
    const tool = (data.tool || '').toString().slice(0, 40)
    const uid = (data.uid || '').toString().slice(0, 80)
    const day = new Date().toISOString().slice(0, 10)

    const store = getStore({ name: 'stats' })
    const raw = (await store.get('agg', { type: 'json' })) as Agg | null
    const agg: Agg = raw || EMPTY

    agg.total += 1
    if (tool) agg.byTool[tool] = (agg.byTool[tool] || 0) + 1
    if (uid && !agg.users.includes(uid)) agg.users.push(uid)
    agg.byDay[day] = (agg.byDay[day] || 0) + 1

    await store.set('agg', JSON.stringify(agg))
    return { statusCode: 204 }
  } catch (e) {
    console.error('track error', e)
    return { statusCode: 500, body: 'Internal Error' }
  }
}
