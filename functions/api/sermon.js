// GET /api/sermon?id=123 — one sermon with its full transcript (as passages).
import { json, handleError, supabase, HttpError } from "../../lib/server.js";

export async function onRequestGet({ request, env }) {
  try {
    const id = parseInt(new URL(request.url).searchParams.get("id"), 10);
    if (!Number.isFinite(id)) throw new HttpError(400, "Missing ?id=");
    const fields = "id,title,description,speaker,series,published_at,audio_url,episode_url,image_url,duration_sec";
    const [sermon] = await supabase(env, `sermons?select=${fields}&id=eq.${id}&transcript_status=eq.done`);
    if (!sermon) throw new HttpError(404, "Sermon not found");
    const passages = await supabase(env, `passages?select=id,idx,start_sec,end_sec,text&sermon_id=eq.${id}&order=idx`);
    return json({ sermon, passages }, { maxAge: 3600 });
  } catch (err) {
    return handleError(err);
  }
}
