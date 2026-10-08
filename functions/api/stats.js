// GET /api/stats — archive size, date range, speakers and years for the filters,
// and whether AI summaries are switched on.
import { json, handleError, supabase } from "../../lib/server.js";

export async function onRequestGet({ env }) {
  try {
    const stats = await supabase(env, "rpc/sermon_stats", { method: "POST", body: {} });
    return json({ ...stats, answers_enabled: Boolean(env.ANTHROPIC_API_KEY) }, { maxAge: 600 });
  } catch (err) {
    return handleError(err);
  }
}
