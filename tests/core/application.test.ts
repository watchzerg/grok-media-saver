import { expect, test } from "bun:test";
import {
  type InspectSession,
  inspectFirstPage,
  type PageResponse,
} from "../../src/application";
import {
  parseSavedPageResponse,
  RetryableRequestError,
  UnconfirmedStopError,
} from "../../src/grok/adapter";

const first = {
  assetId: "123e4567-e89b-42d3-a456-426614174000",
  mimeType: "image/jpeg",
};

function response(body: unknown, status = 200): PageResponse {
  return parseSavedPageResponse({
    status,
    contentType: "application/json",
    body,
    finalPath: "/rest/assets",
  });
}

function sessionFor(
  page: PageResponse,
  close: () => Promise<void> = async () => {},
): InspectSession {
  return {
    getFirstPage: async () => page,
    close,
  };
}

test("inspect first-page returns a valid page without expanding posts", async () => {
  let closeCalls = 0;
  const result = await inspectFirstPage({
    connect: async () =>
      sessionFor(
        response({ assets: [first], nextPageToken: "opaque" }),
        async () => {
          closeCalls += 1;
        },
      ),
  });

  expect(result).toMatchObject({ status: "ok", assets: [first] });
  expect(result.message).toContain("1");
  expect(closeCalls).toBe(1);
});

test("inspect first-page accepts a valid empty page", async () => {
  const result = await inspectFirstPage({
    connect: async () => sessionFor(response({ assets: [] })),
  });
  expect(result).toMatchObject({ status: "ok", assets: [] });
});

test("inspect first-page rejects an unknown response shape and still closes", async () => {
  let closeCalls = 0;
  const result = await inspectFirstPage({
    connect: async () =>
      sessionFor(response({ results: [] }), async () => {
        closeCalls += 1;
      }),
  });
  expect(result.status).toBe("failed");
  expect(result.assets).toEqual([]);
  expect(closeCalls).toBe(1);
});

test("inspect first-page classifies blocking failures and does not retry them", async () => {
  let calls = 0;
  const result = await inspectFirstPage({
    connect: async () => ({
      getFirstPage: async () => {
        calls += 1;
        return response({ message: "Too Many Requests" }, 429);
      },
      close: async () => {},
    }),
  });
  expect(result.status).toBe("blocked");
  expect(calls).toBe(1);
});

test("inspect first-page blocks a login redirect without retrying", async () => {
  let calls = 0;
  const result = await inspectFirstPage({
    connect: async () => ({
      getFirstPage: async () => {
        calls += 1;
        return parseSavedPageResponse({
          status: 302,
          contentType: "text/html",
          body: null,
          finalPath: "/login",
        });
      },
      close: async () => {},
    }),
  });
  expect(result.status).toBe("blocked");
  expect(result.message).toContain("登录或 challenge");
  expect(calls).toBe(1);
});

test("inspect first-page does not retry when request stop is unconfirmed", async () => {
  let calls = 0;
  const result = await inspectFirstPage({
    connect: async () => ({
      getFirstPage: async () => {
        calls += 1;
        throw new UnconfirmedStopError("request stop unconfirmed");
      },
      close: async () => {},
    }),
  });
  expect(result.status).toBe("failed");
  expect(calls).toBe(1);
});

test("inspect first-page returns failure when cleanup fails after a successful read", async () => {
  const result = await inspectFirstPage({
    connect: async () =>
      sessionFor(response({ assets: [] }), async () => {
        throw new Error("close failed");
      }),
  });
  expect(result.status).toBe("failed");
  expect(result.cleanupErrors[0]).toContain("close failed");
});

test("inspect first-page retries one transient response then returns the first page", async () => {
  let calls = 0;
  let waits = 0;
  const result = await inspectFirstPage({
    connect: async () => ({
      getFirstPage: async () => {
        calls += 1;
        return calls === 1 ? response({}, 503) : response({ assets: [first] });
      },
      close: async () => {},
    }),
    waitBeforeRetry: async () => {
      waits += 1;
    },
  });
  expect(result.status).toBe("ok");
  expect(calls).toBe(2);
  expect(waits).toBe(1);
});

test("inspect first-page stops after cancellation and closes its session", async () => {
  const controller = new AbortController();
  let calls = 0;
  let closeCalls = 0;
  const result = await inspectFirstPage({
    signal: controller.signal,
    connect: async () => ({
      getFirstPage: async () => {
        calls += 1;
        controller.abort();
        return response({}, 503);
      },
      close: async () => {
        closeCalls += 1;
      },
    }),
  });
  expect(result.status).toBe("cancelled");
  expect(calls).toBe(1);
  expect(closeCalls).toBe(1);
});

test("inspect first-page keeps Ctrl+C exit classification when browser cleanup also fails", async () => {
  const controller = new AbortController();
  const result = await inspectFirstPage({
    signal: controller.signal,
    connect: async () => ({
      getFirstPage: async () => {
        controller.abort();
        return response({ assets: [first] });
      },
      close: async () => {
        throw new Error("page close timeout");
      },
    }),
  });
  expect(result.status).toBe("cancelled");
  expect(result.cleanupErrors).toHaveLength(1);
});

test("inspect first-page does not retry an unclassified exception", async () => {
  let calls = 0;
  const result = await inspectFirstPage({
    connect: async () => ({
      getFirstPage: async () => {
        calls += 1;
        throw new Error("network reset");
      },
      close: async () => {},
    }),
  });
  expect(result.status).toBe("failed");
  expect(calls).toBe(1);
});

test("inspect first-page retries a classified network failure once", async () => {
  let calls = 0;
  const result = await inspectFirstPage({
    connect: async () => ({
      getFirstPage: async () => {
        calls += 1;
        if (calls === 1) throw new RetryableRequestError("network reset");
        return response({ assets: [first] });
      },
      close: async () => {},
    }),
  });
  expect(result).toMatchObject({ status: "ok", assets: [first] });
  expect(calls).toBe(2);
});

test("inspect first-page accepts any UUID-shaped hex id without version limits", async () => {
  const id = "ffffffff-0000-0000-0000-000000000001";
  const result = await inspectFirstPage({
    connect: async () =>
      sessionFor(response({ assets: [{ ...first, assetId: id }] })),
  });
  expect(result).toMatchObject({ status: "ok", assets: [{ assetId: id }] });
});

test("inspect first-page reports cleanup notices when reading fails", async () => {
  const result = await inspectFirstPage({
    connect: async () => ({
      ...sessionFor(response({}, 503)),
      cleanupNotices: ["connect.html 归属不明，已保留。"],
    }),
  });
  expect(result.status).toBe("failed");
  expect(result.message).toContain("connect.html");
});

test("inspect first-page waits for late connection cleanup after cancellation", async () => {
  const controller = new AbortController();
  let finishConnect!: (session: InspectSession) => void;
  let closeCalls = 0;
  let pageCalls = 0;
  const connecting = new Promise<InspectSession>((resolve) => {
    finishConnect = resolve;
  });
  const resultPromise = inspectFirstPage({
    signal: controller.signal,
    connect: async () => connecting,
  });
  controller.abort();
  finishConnect({
    getFirstPage: async () => {
      pageCalls += 1;
      return response({ assets: [] });
    },
    close: async () => {
      closeCalls += 1;
    },
  });
  const result = await resultPromise;
  expect(result.status).toBe("cancelled");
  expect(pageCalls).toBe(0);
  await Promise.resolve();
  await Promise.resolve();
  expect(closeCalls).toBe(1);
});

test("inspect first-page waits for late connection cleanup and reports its failure", async () => {
  const controller = new AbortController();
  let finishConnect!: (session: InspectSession) => void;
  const connecting = new Promise<InspectSession>((resolve) => {
    finishConnect = resolve;
  });
  const resultPromise = inspectFirstPage({
    signal: controller.signal,
    connect: async () => connecting,
  });

  controller.abort();
  finishConnect({
    ...sessionFor(response({ assets: [] })),
    close: async () => {
      throw new Error("late close failed");
    },
  });

  const result = await resultPromise;
  expect(result.status).toBe("cancelled");
  expect(result.cleanupErrors).toEqual(["浏览器清理失败：late close failed"]);
  expect(result.message).toContain("late close failed");
});

test("inspect first-page never retries an unknown page structure", async () => {
  let calls = 0;
  const result = await inspectFirstPage({
    connect: async () => ({
      getFirstPage: async () => {
        calls += 1;
        return response({ assets: [{ assetId: "bad" }] });
      },
      close: async () => {},
    }),
  });
  expect(result.status).toBe("failed");
  expect(calls).toBe(1);
});

test("inspect first-page hides the configured extension token from connector errors", async () => {
  const result = await inspectFirstPage({
    secrets: ["secret-extension-token"],
    connect: async () => {
      throw new Error(
        "extension failed at https://local/connect.html?token=secret-extension-token",
      );
    },
  });
  expect(result.status).toBe("failed");
  expect(result.message).not.toContain("secret-extension-token");
  expect(result.message).toContain("[已隐藏]");
});
