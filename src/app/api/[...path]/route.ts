import { handleApi } from "@/server/router";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const handler = async (request: Request, context: Context) => handleApi(request, (await context.params).path);
export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
