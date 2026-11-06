// Outside RSC, the shared screens use document navigation. Library query-state
// navigation remains handled by page.tsx, including history and scroll state.
export const usePathname = () => window.location.pathname;
const router = {
  push: (url: string) => window.location.assign(url),
  replace: (url: string) => window.location.replace(url),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => window.location.reload(),
  prefetch: () => {},
};
export const useRouter = () => router;
