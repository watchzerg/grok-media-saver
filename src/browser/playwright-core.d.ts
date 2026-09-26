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
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  evaluate<T>(fn: (input: string) => Promise<T>, input: string): Promise<T>;
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
  isClosed(): boolean;
};
