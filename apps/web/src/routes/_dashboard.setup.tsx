import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";

export const Route = createFileRoute("/_dashboard/setup")({ component: Setup });

const baseUrl = "https://api.router.agentfan.club/inference/v1";
const linkClass = "text-neutral-800 underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-600";
const stepsClass = "space-y-7 text-[13px] leading-6 text-neutral-500 [&_p_code]:rounded [&_p_code]:border [&_p_code]:border-neutral-200 [&_p_code]:bg-neutral-50 [&_p_code]:px-1 [&_p_code]:py-0.5 [&_p_code]:text-xs [&_p_code]:text-neutral-700";

function Setup() {
  return (
    <section className="mx-auto w-full max-w-[1008px] px-6 pb-10 pt-10 max-[480px]:px-4">
      <h1 className="text-lg font-medium">Setup</h1>
      <p className="mt-1 text-sm text-neutral-500">Connect your tools to Agent Fan Club Router</p>

      <Tabs defaultValue="opencode" className="mt-6">
        <TabsList aria-label="Choose your tool" className="flex h-auto w-full justify-start gap-6 overflow-x-auto rounded-none border-b border-neutral-200 bg-transparent p-0">
          {[
            ["opencode", "OpenCode"],
            ["pi", "Pi"],
            ["other", "Other tools"],
            ["api", "API"],
          ].map(([value, label]) => (
            <TabsTrigger key={value} value={value} className="shrink-0 rounded-none border-b-2 border-transparent px-0 py-3 text-[13px] font-normal text-neutral-500 shadow-none transition-colors hover:text-neutral-800 data-[state=active]:border-black data-[state=active]:bg-transparent data-[state=active]:text-neutral-800 data-[state=active]:shadow-none">{label}</TabsTrigger>
          ))}
        </TabsList>

        <div className="max-w-[680px] pt-7">
          <TabsContent value="opencode" className="mt-0">
            <p className="mb-7 text-[13px] leading-6 text-neutral-500">Need OpenCode? Follow the <a href="https://opencode.ai/v2/docs/#cli" target="_blank" rel="noopener noreferrer" className={linkClass}>OpenCode v2 installation instructions</a>.</p>
            <ol className={stepsClass}>
              <SetupStep title="Add the plugin">
                <p>Run this in your terminal. Requires OpenCode v2.</p>
                <CodeBlock label="Terminal" code="opencode plugin add @agentfanclub/opencode" />
              </SetupStep>
              <SetupStep title="Connect your account">
                <p>Restart OpenCode, run <code>/connect</code>, and select <span className="text-neutral-800">Agent Fan Club</span>. Choose <span className="text-neutral-800">Sign in to Agent Fan Club</span>, open the browser link, and sign in with your Illinois account. Check that the code matches your terminal, then approve.</p>
              </SetupStep>
              <SetupStep title="Choose a model">
                <p>Run <code>/models</code> and select an Agent Fan Club model. Your available models are loaded automatically.</p>
              </SetupStep>
            </ol>
          </TabsContent>

          <TabsContent value="pi" className="mt-0">
            <p className="mb-7 text-[13px] leading-6 text-neutral-500">Need Pi? Follow the <a href="https://pi.dev/docs/latest/quickstart#1-install-pi" target="_blank" rel="noopener noreferrer" className={linkClass}>Pi installation instructions</a>.</p>
            <ol className={stepsClass}>
              <SetupStep title="Install the extension">
                <CodeBlock label="Terminal" code="pi install npm:@agentfanclub/pi" />
                <p className="mt-3">Using Oh My Pi? Install the same package with its plugin command.</p>
                <CodeBlock label="Oh My Pi" code="omp plugin install @agentfanclub/pi" />
              </SetupStep>
              <SetupStep title="Sign in">
                <p>Restart Pi, run <code>/login</code>, and select <span className="text-neutral-800">Agent Fan Club</span>. Open the browser link and sign in with your Illinois account. Check that the code matches your terminal, then approve.</p>
              </SetupStep>
              <SetupStep title="Choose a model">
                <p>Run <code>/model</code> and select an Agent Fan Club model. These steps also work in Oh My Pi.</p>
              </SetupStep>
            </ol>
          </TabsContent>

          <TabsContent value="other" className="mt-0">
            <ol className={stepsClass}>
              <SetupStep title="Create an API key">
                <p>Create a key in <Link to="/api-keys" className={linkClass}>API Keys</Link> and copy it when it&apos;s shown.</p>
              </SetupStep>
              <SetupStep title="Add a custom provider">
                <p>Choose OpenAI-compatible or OpenAI Chat Completions in your tool&apos;s provider settings. Set the base URL below and paste your Agent Fan Club key into the API key field.</p>
                <CodeBlock label="Base URL" code={baseUrl} />
              </SetupStep>
              <SetupStep title="Set the model ID">
                <p>Copy a model ID from <Link to="/models" className={linkClass}>Models</Link> into your tool. For example:</p>
                <CodeBlock label="Model ID" code="glm-5.3" />
                <p className="mt-3">Enter the model ID manually if your tool cannot discover models. The API supports Chat Completions; select that mode if your tool offers multiple OpenAI API types.</p>
              </SetupStep>
            </ol>
          </TabsContent>

          <TabsContent value="api" className="mt-0">
            <ol className={stepsClass}>
              <SetupStep title="Set your API key">
                <p>Create a key in <Link to="/api-keys" className={linkClass}>API Keys</Link>, then replace the placeholder below with it.</p>
                <CodeBlock label="Terminal" code={'export AGENTFANCLUB_API_KEY="sk-afcrouter-..."'} />
              </SetupStep>
              <SetupStep title="Send a request">
                <p>Use the Chat Completions endpoint with your key as a bearer token.</p>
                <CodeBlock label="curl" code={`curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer $AGENTFANCLUB_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "glm-5.3",\n    "messages": [{"role": "user", "content": "Hello!"}],\n    "max_tokens": 256\n  }'`} />
              </SetupStep>
              <SetupStep title="Find available models">
                <p>Browse <Link to="/models" className={linkClass}>Models</Link> or fetch the catalog. The response is an object keyed by model ID.</p>
                <CodeBlock label="curl" code={'curl https://api.router.agentfan.club/api/models \\\n  -H "Authorization: Bearer $AGENTFANCLUB_API_KEY"'} />
              </SetupStep>
            </ol>
          </TabsContent>
        </div>
      </Tabs>
    </section>
  );
}

function SetupStep({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li>
      <h3 className="mb-1.5 text-sm font-medium text-neutral-800">{title}</h3>
      {children}
    </li>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="mt-3">
      <div className="flex items-start overflow-hidden rounded-[7px] border border-neutral-200 bg-neutral-50">
        <pre className="min-w-0 flex-1 overflow-x-auto p-3 font-mono text-xs leading-6 text-neutral-700"><code>{code}</code></pre>
        <button type="button" aria-label={`Copy ${label}`} className="m-2 inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] leading-6 text-neutral-400 hover:text-neutral-800 focus-visible:ring-2 focus-visible:ring-neutral-400" onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setError(false);
          } catch {
            setError(true);
          }
        }}>
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          <span role="status">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      {error && <p role="alert" className="mt-2 text-xs text-red-700">Couldn&apos;t copy. Select the text and copy it manually.</p>}
    </div>
  );
}
