import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { RouteGame } from "../components/route-game";
import stylesheet from "../styles.css?url";

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
  }),
  component: Root,
  notFoundComponent: RouteGame,
});

function Root() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
