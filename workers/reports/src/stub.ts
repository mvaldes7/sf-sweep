/** Placeholder Worker. Deployed until Mike OKs the real reports Worker. Returns 503 for every request. */
export default {
  fetch(): Response {
    return new Response("Service unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "Retry-After": "86400" },
    });
  },
};
