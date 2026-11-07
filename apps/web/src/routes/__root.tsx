import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { RouteGame } from "../components/route-game";
import { ThemeProvider, themeScript } from "../components/theme-provider";
import stylesheet from "../styles.css?url";

// Runs before hydration so the first client-side data request already carries
// the viewer's UTC offset. `getTimezoneOffset()` is minutes west of UTC; the
// cookie stores minutes east, matching the API's `tzOffset` parameter.
const timezoneCookieScript = `try{document.cookie="tzOffset="+(-new Date().getTimezoneOffset())+";path=/;max-age=31536000;SameSite=Lax"}catch(e){}`;

export const Route = createRootRoute({
  head: () => ({
    links: [
      { rel: "preconnect", href: "https://api.fontshare.com" },
      { rel: "preconnect", href: "https://cdn.fontshare.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://api.fontshare.com/v2/css?f[]=switzer@1&display=swap" },
      { rel: "stylesheet", href: stylesheet },
    ],
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Router" },
    ],
    scripts: [{ children: themeScript }, { children: timezoneCookieScript }],
  }),
  component: Root,
  notFoundComponent: RouteGame,
});

function Root() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider><Outlet /></ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
