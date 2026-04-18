import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";

const repoSrc = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const nodeEnv = (mode: string) => (mode === "production" ? "production" : "development");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const api =
    env.VITE_API_PROXY_TARGET?.trim() ||
    (env.PERPS_API_PORT?.trim()
      ? `http://127.0.0.1:${env.PERPS_API_PORT.trim()}`
      : "http://127.0.0.1:8791");
  const envLiteral = JSON.stringify(nodeEnv(mode));
  return {
    plugins: [
      /** Runs before ESM: wallet/crypto deps expect Node `global` / `process` (SES-safe). */
      {
        name: "inject-browser-node-globals",
        transformIndexHtml(html) {
          /** `readable-stream` / md5 path uses `process.version.slice` — must be a string. */
          /** libsodium-sumo reads `process.argv.length` during init. */
          const snippet = `<script>try{const g=globalThis;g.global??=g;const p=g.process??={env:{}};p.env??={};p.env.NODE_ENV??=${envLiteral};if(typeof p.version!="string")p.version="v20.0.0";if(!p.versions||typeof p.versions!="object")p.versions={node:"20.0.0"};if(!Array.isArray(p.argv))p.argv=["browser"];}catch(e){}</script>`;
          if (html.includes("<head")) {
            return html.replace("<head>", `<head>${snippet}`);
          }
          return snippet + html;
        },
      },
      react(),
      wasm(),
      topLevelAwait(),
    ],
    /** Node-style libs reference `global` / `process.env`; browsers use `globalThis` and a minimal `process`. */
    define: {
      global: "globalThis",
      "process.env.NODE_ENV": JSON.stringify(nodeEnv(mode)),
    },
    optimizeDeps: {
      include: ["buffer"],
      esbuildOptions: {
        define: {
          global: "globalThis",
          "process.env.NODE_ENV": JSON.stringify(nodeEnv(mode)),
        },
      },
    },
    /** Must be esnext so vite-plugin-top-level-await uses a single high target; otherwise it downlevels
     *  with Vite's default browser list and esbuild errors on destructuring in WASM deps. */
    build: {
      target: "esnext",
    },
    resolve: {
      alias: {
        "@charlie3": repoSrc,
        buffer: "buffer",
      },
    },
    server: {
      port: 5173,
      /** Bind IPv4 so `http://127.0.0.1:5173` matches browser/proxy (avoids [::1]-only listen). */
      host: "127.0.0.1",
      proxy: {
        "/api": {
          target: api,
          changeOrigin: true,
          /** Long `POST /api/trade/submit` (Midnight + Cardano) — avoid proxy cutting the connection early. */
          timeout: 0,
          proxyTimeout: 0,
          configure: (proxy) => {
            proxy.on("error", (err, _req, res) => {
              console.warn("[vite] /api proxy:", err.message);
              try {
                const r = res as { writeHead?: unknown; end?: unknown; headersSent?: boolean } | undefined;
                if (r && r.writeHead && typeof r.end === "function" && !r.headersSent) {
                  (r as NodeJS.ServerResponse).writeHead(502, {
                    "Content-Type": "application/json",
                  });
                  (r as NodeJS.ServerResponse).end(
                    JSON.stringify({
                      error:
                        "API unreachable. Ensure perps-api is listening (e.g. port 8791) and not OOM-restarting during a heavy trade.",
                    }),
                  );
                }
              } catch {
                /* ignore */
              }
            });
          },
        },
      },
    },
  };
});
