// Functions v2 写法（export default）——v1（export const handler）运行时
// 不注入 Netlify Blobs 环境，getStore 会抛 MissingBlobsEnvironmentError 导致 502
import { getStore } from '@netlify/blobs'

interface Agg {
  total: number
  byTool: Record<string, number>
  users: string[]
  byDay: Record<string, number>
}

const EMPTY: Agg = { total: 0, byTool: {}, users: [], byDay: {} }

export default async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  try {
    const data = (await req.json().catch(() => ({}))) as {
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
    return new Response(null, { status: 204 })
  } catch (e) {
    console.error('track error', e)
    return new Response('Internal Error', { status: 500 })
  }
}
