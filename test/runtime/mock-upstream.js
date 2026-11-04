const configurations = new Map();

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "fixture.test" && request.method === "POST") {
      const config = await request.json();
      configurations.set(config.domain, { ...config, certRequests: 0, redirectVisits: 0 });
      return new Response(null, { status: 204 });
    }
    if (url.hostname === "fixture.test") return Response.json(configurations.get(url.searchParams.get("domain")));
    if (url.pathname === "/cdn-cgi/access/certs") {
      const config = configurations.get(url.hostname);
      if (!config) throw new Error("Unexpected public-key hostname");
      config.certRequests++;
      if (config.certRedirect) return Response.redirect(`https://redirect-target.invalid/${config.domain}/certs`, 302);
      return Response.json({ keys: config.keys });
    }
    if (url.hostname === "api.resend.com" && url.pathname === "/emails") {
      if (request.method === "GET") {
        const domain = request.headers.get("Authorization")?.replace("Bearer runtime-outbox:", "");
        const config = configurations.get(domain);
        if (!config) throw new Error("Incorrect outbox read key");
        if (config.outboxRedirect) return Response.redirect(`https://redirect-target.invalid/${domain}/emails`, 307);
        const mail = { id: "f12e0ef2-c8b3-4ba5-9cd7-13e096efa42f", from: config.from, to: ["recipient@example.com"], subject: "Runtime outbox", created_at: new Date().toISOString(), last_event: "delivered", text: "Runtime outbox content" };
        const otherFrom = config.from.includes("hi@wzy.one") ? "admin@wzy.one" : "hi@wzy.one";
        return Response.json(url.searchParams.has("after") ? { data: [], has_more: false } : { data: [mail, { ...mail, id: "bcd23456-c8b3-4ba5-9cd7-13e096efa42f", from: otherFrom }], has_more: true });
      }
      if (request.method !== "POST" || request.headers.get("Authorization") !== "Bearer runtime-test-secret") throw new Error("Incorrect Resend request");
      const mail = await request.json();
      const config = [...configurations.values()].reverse().find((entry) => entry.from === mail.from);
      if (!config) throw new Error("Unexpected mail sender");
      if (config.sendRedirect) return Response.redirect(`https://redirect-target.invalid/${config.domain}/emails`, 307);
      return Response.json({ id: "runtime-message-id" });
    }
    if (url.hostname === "api.resend.com" && url.pathname.startsWith("/emails/")) {
      const config = configurations.get(request.headers.get("Authorization")?.replace("Bearer runtime-outbox:", ""));
      if (!config) throw new Error("Incorrect detail read key");
      const id = url.pathname.slice("/emails/".length);
      const otherFrom = config.from.includes("hi@wzy.one") ? "admin@wzy.one" : "hi@wzy.one";
      return Response.json({ id, from: id.startsWith("bcd") ? otherFrom : config.from, to: ["recipient@example.com"], subject: "Runtime outbox", created_at: new Date().toISOString(), last_event: "delivered", text: "Runtime outbox content" });
    }
    if (url.hostname === "redirect-target.invalid") {
      const config = configurations.get(url.pathname.split("/")[1]);
      config.redirectVisits++;
      return Response.json(url.pathname.endsWith("/certs") ? { keys: config.keys } : { id: "unexpected-redirect-id" });
    }
    throw new Error("Runtime tests must not contact external services");
  },
};
