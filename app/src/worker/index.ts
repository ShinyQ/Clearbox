export default {
  async fetch(): Promise<Response> {
    return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
