/** The public repository URL is fixed by decision W14. */
export const DOCS_BASE_URL = "https://github.com/ShinyQ/Clearbox/blob/main/docs/";
export const docsUrl = (file: string): string => `${DOCS_BASE_URL}${file}`;
export const SIGN_OUT_URL = "/cdn-cgi/access/logout";

/** Full navigations go through this object so tests can replace them. */
export const browser = {
  assign: (url: string): void => window.location.assign(url),
  reload: (): void => window.location.reload(),
  open: (url: string): void => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
};
