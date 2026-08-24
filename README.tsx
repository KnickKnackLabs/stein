/** @jsxImportSource jsx-md */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  Badge,
  Badges,
  Bold,
  Center,
  Code,
  CodeBlock,
  Details,
  Heading,
  HR,
  Image,
  Item,
  Link,
  List,
  Paragraph,
  Raw,
  Section,
  Sub,
} from "readme";

const ROOT = resolve(import.meta.dirname);
const TEST_ROOT = join(ROOT, "test");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function countTests(directory = TEST_ROOT): number {
  if (!existsSync(directory)) return 0;
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += countTests(path);
    else if (path.endsWith(".test.ts")) count += read(path).match(/\btest\s*\(/g)?.length ?? 0;
  }
  return count;
}

function configuredLintCount(): number {
  const mise = read(join(ROOT, "mise.toml"));
  const block = mise.match(/\[_\.codebase\][\s\S]*?lint\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].length;
}

const packageJson = JSON.parse(read(join(ROOT, "package.json"))) as {
  dependencies?: Record<string, string>;
};
const piVersion = packageJson.dependencies?.["@earendil-works/pi-coding-agent"] ?? "unknown";

const readme = (
  <>
    <Center>
      <Paragraph>
        <Image
          src="assets/stein.webp"
          alt="A wooden outhouse standing alone in the desert"
          width={800}
        />
      </Paragraph>
      <Heading level={1}>stein</Heading>
      <Paragraph>
        <Bold>Persistent Pi sessions that know how to roll back.</Bold>
      </Paragraph>
      <Badges>
        <Badge label="tests" value={`${countTests()}`} color="brightgreen" href="test/" />
        <Badge label="lints" value={`${configuredLintCount()}`} color="blue" href="mise.toml" />
        <Badge label="Pi" value={piVersion} color="f472b6" href="package.json" />
      </Badges>
    </Center>

    <Paragraph>
      Stein is a private TypeScript reference harness for product services built around persistent{" "}
      <Link href="https://github.com/badlogic/pi-mono">Pi</Link> sessions. It keeps the generic
      runtime, transaction, persistence, and OpenAI-compatible boundaries in one reviewed place;
      product repositories add their own prompts, tools, workflows, deployment, and data policy.
    </Paragraph>

    <Section title="Run one turn">
      <CodeBlock lang="bash">{`mise run install
mise run session:run -- \\
  --pi-model provider/model \\
  --system-prompt-file /absolute/private/system.md \\
  --prompt-file /absolute/private/prompt.md \\
  --workspace /absolute/private/workspaces \\
  --session-dir /absolute/private/sessions \\
  --agent-dir /absolute/pi-agent \\
  --conversation-id local-smoke`}</CodeBlock>
      <Paragraph>
        Reusing the conversation identifier resumes its Pi JSONL. Stein creates a private workspace
        beneath the supplied root and streams only the successful assistant attempt to standard
        output.
      </Paragraph>
    </Section>

    <Section title="Serve chat">
      <CodeBlock lang="bash">{`mise run serve -- \\
  --listen 127.0.0.1:8787 \\
  --service-token-file /absolute/private/service-tokens \\
  --pi-model provider/model \\
  --system-prompt-file /absolute/private/system.md \\
  --workspace /absolute/private/workspaces \\
  --session-dir /absolute/private/sessions \\
  --agent-dir /absolute/pi-agent`}</CodeBlock>
      <Paragraph>
        The token file accepts one bearer token per nonempty line for overlap during rotation.{" "}
        <Code>GET /health</Code> is public; <Code>GET /v1/models</Code> and streaming{" "}
        <Code>POST /v1/chat/completions</Code> require authentication. Request abort and response
        cancellation both roll the active turn back.
      </Paragraph>
    </Section>

    <Section title="The transaction">
      <List>
        <Item>Resolve user and chat identity into one private local conversation identifier.</Item>
        <Item>Require the caller's visible role/content history to match the committed path.</Item>
        <Item>Run one Pi turn, discarding output from failed automatic retry attempts.</Item>
        <Item>
          Atomically save visible history with the new Pi leaf, or restore the prior leaf before
          reuse.
        </Item>
      </List>
      <Paragraph>
        Typed turn participants can attach product state to the same rollback boundary by returning
        restore closures. The file history store keeps mode-0600 versioned snapshots under a
        mode-0700 directory and restores the committed Pi leaf after a process restart.
      </Paragraph>
    </Section>

    <Section title="Build a product harness">
      <Paragraph>
        <Code>createPiSessionFactory</Code> starts from a deliberately quiet baseline: one exact
        model, no fallback, no tools, no model-catalog network access, and no ambient extensions,
        skills, templates, themes, or context files. Products opt into only what they need:
      </Paragraph>
      <List>
        <Item>
          Read-only Pi credentials with an immutable API key store and in-memory model catalog.
        </Item>
        <Item>
          Explicit built-in and custom tool composition while preserving no-tools as the default.
        </Item>
        <Item>Per-conversation mode-0700 workspaces and typed rollback participants.</Item>
        <Item>
          Scoped <Code>read</Code>, <Code>grep</Code>, <Code>find</Code>, <Code>ls</Code>,{" "}
          <Code>write</Code>, and <Code>edit</Code> tools over product-owned virtual roots.
        </Item>
        <Item>
          Content-free activity events containing sanitized tool, virtual target, status, and
          duration.
        </Item>
      </List>
    </Section>

    <Section title="Open WebUI adapters">
      <Paragraph>
        The generic chat service requires injected identity resolution and optionally accepts
        attachment normalization. Its core knows no Open WebUI header or markup names.
      </Paragraph>
      <List>
        <Item>
          The default serve task uses explicit legacy user/chat headers for a trusted private proxy
          boundary.
        </Item>
        <Item>
          The optional signed adapter verifies an HS256 Open WebUI JWT, issuer, subject, lifetime,
          and separate chat ID while ignoring spoofable legacy identity headers.
        </Item>
        <Item>
          The optional KKL adapter converts the fork's embedded attached-file markup into Stein's
          structured text attachments without changing generic OpenAI semantics.
        </Item>
      </List>
    </Section>

    <Details summary="Runtime and security boundaries">
      <List>
        <Item>
          Conversation workspaces use mode <Code>0700</Code>; visible-history snapshots use mode{" "}
          <Code>0600</Code>.
        </Item>
        <Item>
          Prompt and token inputs must be regular final paths with no group/world permission bits;
          parent-directory safety remains an operator responsibility.
        </Item>
        <Item>
          Chat accepts at most 200 messages, 20 text attachments, and 2 MiB aggregate UTF-8 text.
        </Item>
        <Item>
          Scoped filesystem checks are in-process userspace protection, not an operating-system
          sandbox, and cannot eliminate concurrent filesystem races.
        </Item>
        <Item>
          Visible-history snapshots omit attachments and model internals; Pi JSONL remains the
          model-context record.
        </Item>
        <Item>
          Snapshot replacement provides process-crash recovery, not power-loss durability or
          multi-process transactions.
        </Item>
        <Item>
          Deployment, user provisioning, retention, backup, and product data policy remain separate
          review boundaries.
        </Item>
      </List>
    </Details>

    <Section title="Develop">
      <CodeBlock lang="bash">{`mise trust
mise install
mise run install
mise run check`}</CodeBlock>
      <Paragraph>
        The public check runs README drift detection, Biome, strict TypeScript, the Bun suite,
        KnickKnackLabs/codebase lints, and whitespace checks. CI runs the same command. Format
        intentionally changed files with <Code>bun run format</Code>.
      </Paragraph>
    </Section>

    <Center>
      <HR />
      <Sub>
        <Raw>{`Generated with <a href="https://github.com/KnickKnackLabs/readme">readme</a>`}</Raw>
      </Sub>
    </Center>
  </>
);

console.log(readme);
