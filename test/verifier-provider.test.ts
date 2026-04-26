/**
 * Tests for multi-provider LLM verifier (v3.0).
 *
 * - anthropic: invalid/missing key → descriptive error
 * - openai: missing OPENAI_API_KEY → error
 * - ollama: mock HTTP server returns expected response format
 */

import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import type { Contract } from "../src/types.js";
import { runContract } from "../src/verifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLlmContract(
	prompt: string,
	provider: "anthropic" | "openai" | "ollama",
	model?: string,
	baseUrl?: string,
): Contract {
	return {
		id: "llm-test",
		title: "LLM verifier test",
		checked: false,
		status: "pending",
		line: 0,
		rawLines: [0],
		verifier: {
			kind: "llm",
			prompt,
			provider,
			...(model !== undefined ? { model } : {}),
			...(baseUrl !== undefined ? { baseUrl } : {}),
		},
	};
}

/**
 * Spin up a minimal HTTP server that responds to POST requests.
 * Returns the server and its base URL.
 */
function startMockServer(
	handler: (body: string) => string,
): Promise<{ server: Server; baseUrl: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				const responseBody = handler(body);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(responseBody);
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address === "object" && address !== null) {
				resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Tests: anthropic provider
// ---------------------------------------------------------------------------

describe("LLM verifier — anthropic provider", () => {
	it("fails with descriptive error when ANTHROPIC_API_KEY is not set", async () => {
		const savedKey = process.env.ANTHROPIC_API_KEY;
		try {
			delete process.env.ANTHROPIC_API_KEY;
			const contract = makeLlmContract("Is this code correct?", "anthropic");
			const result = await runContract(contract, "/tmp");
			assert.equal(result.passed, false);
			assert.ok(
				result.stderr.includes("ANTHROPIC_API_KEY"),
				`expected ANTHROPIC_API_KEY mention in stderr, got: ${result.stderr}`,
			);
		} finally {
			if (savedKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = savedKey;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: openai provider
// ---------------------------------------------------------------------------

describe("LLM verifier — openai provider", () => {
	it("fails with descriptive error when OPENAI_API_KEY is not set", async () => {
		const savedKey = process.env.OPENAI_API_KEY;
		try {
			delete process.env.OPENAI_API_KEY;
			const contract = makeLlmContract("Is this code correct?", "openai");
			const result = await runContract(contract, "/tmp");
			assert.equal(result.passed, false);
			assert.ok(
				result.stderr.includes("OPENAI_API_KEY"),
				`expected OPENAI_API_KEY mention in stderr, got: ${result.stderr}`,
			);
		} finally {
			if (savedKey !== undefined) {
				process.env.OPENAI_API_KEY = savedKey;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: ollama provider (mock server)
// ---------------------------------------------------------------------------

describe("LLM verifier — ollama provider (mock)", () => {
	it("passes when mock ollama server returns PASS", async () => {
		const { server, baseUrl } = await startMockServer(() =>
			JSON.stringify({
				message: { role: "assistant", content: "PASS" },
				done: true,
			}),
		);

		try {
			const contract = makeLlmContract(
				"Does the output look correct?",
				"ollama",
				"llama3.2",
				baseUrl,
			);
			const result = await runContract(contract, "/tmp");
			assert.equal(result.passed, true, `stderr: ${result.stderr}`);
			assert.ok(result.stdout.includes("PASS"), `stdout: ${result.stdout}`);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("fails when mock ollama server returns FAIL", async () => {
		const { server, baseUrl } = await startMockServer(() =>
			JSON.stringify({
				message: { role: "assistant", content: "FAIL" },
				done: true,
			}),
		);

		try {
			const contract = makeLlmContract(
				"Does the output look correct?",
				"ollama",
				"llama3.2",
				baseUrl,
			);
			const result = await runContract(contract, "/tmp");
			assert.equal(result.passed, false);
			assert.equal(result.exitCode, 1);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("handles ollama error response gracefully", async () => {
		const { server, baseUrl } = await startMockServer(() =>
			JSON.stringify({ error: "model not found" }),
		);

		try {
			const contract = makeLlmContract(
				"Does the output look correct?",
				"ollama",
				"nonexistent-model",
				baseUrl,
			);
			const result = await runContract(contract, "/tmp");
			assert.equal(result.passed, false);
			assert.ok(result.stderr.includes("model not found"), `stderr: ${result.stderr}`);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("uses default ollama base url (http://localhost:11434) when not specified", async () => {
		// This test verifies that the contract is constructed correctly with the
		// default base URL path. We can't actually connect to localhost:11434 in CI,
		// so we just verify the error is a connection error (not a config error).
		const contract = makeLlmContract("Test prompt", "ollama", "llama3.2");
		// No baseUrl — will try to connect to localhost:11434
		const result = await runContract(contract, "/tmp");
		// Should fail (connection refused) but not fail due to missing API key
		assert.equal(result.passed, false);
		// Should not have API key error
		assert.ok(
			!result.stderr.includes("API_KEY"),
			`should not be API key error, got: ${result.stderr}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Tests: openai provider with mock server
// ---------------------------------------------------------------------------

describe("LLM verifier — openai provider (mock)", () => {
	it("passes when mock openai server returns PASS", async () => {
		const { server, baseUrl } = await startMockServer(() =>
			JSON.stringify({
				choices: [{ message: { role: "assistant", content: "PASS" } }],
			}),
		);

		const savedKey = process.env.OPENAI_API_KEY;
		try {
			process.env.OPENAI_API_KEY = "test-key";
			const contract = makeLlmContract(
				"Does the output look correct?",
				"openai",
				"gpt-4o-mini",
				baseUrl,
			);
			const result = await runContract(contract, "/tmp");
			assert.equal(result.passed, true, `stderr: ${result.stderr}`);
		} finally {
			if (savedKey !== undefined) {
				process.env.OPENAI_API_KEY = savedKey;
			} else {
				delete process.env.OPENAI_API_KEY;
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
