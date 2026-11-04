using Workerd = import "/workerd/workerd.capnp";

# The installed workerd 2026-05-26 supports dates through 2026-06-02.
# Outbound fetches use a local service, with no listening sockets or external API calls.
const config :Workerd.Config = (
  services = [
    (name = "mailroom-runtime", worker = (
      compatibilityDate = "2026-06-02",
      modules = [
        (name = "test/runtime/runtime-tests.js", esModule = embed "runtime-tests.js"),
        (name = "src/worker.js", esModule = embed "../../src/worker.js"),
        (name = "src/session.js", esModule = embed "../../src/session.js"),
        (name = "src/outbox.js", esModule = embed "../../src/outbox.js"),
        (name = "src/access.js", esModule = embed "../../src/access.js")
      ],
      globalOutbound = "mock-upstream",
      bindings = [(name = "UPSTREAM", service = "mock-upstream")]
    )),
    (name = "mock-upstream", worker = (
      compatibilityDate = "2026-06-02",
      modules = [(name = "mock-upstream.js", esModule = embed "mock-upstream.js")],
      globalOutbound = "mock-upstream"
    ))
  ]
);
