declare module "playwright-core/lib/coreBundle" {
  const bundle: {
    tools: {
      createBrowserWithInfo(
        options: Record<string, unknown>,
        metadata: Record<string, unknown>,
        browserOptions: Record<string, unknown>,
      ): Promise<{ browser: BrowserLike }>;
    };
  };
  export default bundle;
}

type BrowserLike = {
  contexts(): BrowserContextLike[];
  on(event: "disconnected", listener: () => void): void;
  close(): Promise<void>;
};

type BrowserContextLike = {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
};

type PageLike = {
  url(): string;
  route(
    url: string,
    handler: (route: PageRouteLike) => Promise<void>,
  ): Promise<void>;
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<PageResponseLike | null>;
  waitForResponse(
    predicate: (response: PageResponseLike) => boolean,
    options: { timeout: number },
  ): Promise<PageResponseLike>;
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
  isClosed(): boolean;
};

type PageRouteLike = {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
};

type PageResponseLike = {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  json(): Promise<unknown>;
};
