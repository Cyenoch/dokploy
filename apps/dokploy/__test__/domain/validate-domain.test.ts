import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolve4Mock, resolveCnameMock } = vi.hoisted(() => ({
	resolve4Mock: vi.fn(),
	resolveCnameMock: vi.fn(),
}));

vi.mock("node:dns", () => ({
	default: {
		resolve4: resolve4Mock,
		resolveCname: resolveCnameMock,
	},
}));

import { validateDomain } from "@dokploy/server/services/domain";

type ResolveCallback<T> = (error: Error | null, result?: T) => void;

const normalizeHostname = (hostname: string) =>
	hostname.toLowerCase().replace(/\.$/, "");

const mockResolve4 = (ips: string[]) => {
	resolve4Mock.mockImplementation(
		(...args: [string, ResolveCallback<string[]>]) => {
			args[1](null, ips);
		},
	);
};

const mockResolveCname = (recordsByHostname: Record<string, string[]>) => {
	resolveCnameMock.mockImplementation(
		(...args: [string, ResolveCallback<string[]>]) => {
			const [hostname, callback] = args;
			const cnames = recordsByHostname[normalizeHostname(hostname)];

			if (!cnames) {
				callback(new Error("queryCname ENODATA"));
				return;
			}

			callback(null, cnames);
		},
	);
};

describe("validateDomain", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not bypass expected IP validation for Tencent EdgeOne origin-pull ranges", async () => {
		mockResolve4(["3.105.21.10"]);
		mockResolveCname({});

		const result = await validateDomain("example.com", "203.0.113.10");

		expect(result).toEqual({
			isValid: false,
			resolvedIp: "3.105.21.10",
			error: "Domain resolves to 3.105.21.10 but should point to 203.0.113.10",
		});
	});

	it("accepts Tencent EdgeOne CNAME targets", async () => {
		mockResolve4(["59.56.100.101"]);
		mockResolveCname({
			"www.example.com": ["www.example.com.eo.dnse5.com."],
		});

		const result = await validateDomain(
			"https://www.example.com/path",
			"203.0.113.10",
		);

		expect(result).toEqual({
			isValid: true,
			resolvedIp: "59.56.100.101",
			cdnProvider: "Tencent EdgeOne",
			error:
				"Domain is behind Tencent EdgeOne - actual IP is masked by CDN proxy",
		});
	});

	it("follows CNAME chains to Tencent EdgeOne", async () => {
		mockResolve4(["59.56.100.101"]);
		mockResolveCname({
			"app.example.com": ["edge.example.net"],
			"edge.example.net": ["app.example.com.eo.dnse5.com"],
		});

		const result = await validateDomain("app.example.com", "203.0.113.10");

		expect(result.isValid).toBe(true);
		expect(result.cdnProvider).toBe("Tencent EdgeOne");
	});

	it("keeps accepting Cloudflare proxy IPs without CNAME lookup", async () => {
		mockResolve4(["104.16.0.1"]);
		mockResolveCname({});

		const result = await validateDomain("example.com", "203.0.113.10");

		expect(result).toEqual({
			isValid: true,
			resolvedIp: "104.16.0.1",
			cdnProvider: "Cloudflare",
			error:
				"Domain is behind Cloudflare - actual IP is masked by Cloudflare proxy",
		});
		expect(resolveCnameMock).not.toHaveBeenCalled();
	});
});
