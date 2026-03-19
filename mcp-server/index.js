#!/usr/bin/env node
/**
 * OpenClaw Browser Automation MCP Server
 *
 * This server implements the Model Context Protocol (MCP) for browser automation,
 * providing AI models like Claude with standardized browser control capabilities.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// CDP Service Client (simplified version)
class CdpServiceClient {
  constructor(options) {
    this.serviceUrl = options.serviceUrl;
    this.authToken = options.authToken;
    this.defaultTimeout = options.defaultTimeout || 30000;
  }

  async evaluate(params) {
    const response = await fetch(`${this.serviceUrl}/api/v1/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify({
        agentId: params.agentId || 'mcp-agent',
        expression: params.expression,
        awaitPromise: params.awaitPromise !== false,
        returnByValue: params.returnByValue !== false,
        budget: {
          timeoutMs: params.budget?.timeoutMs || this.defaultTimeout
        }
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`CDP Service error: ${error.error || response.statusText}`);
    }

    return await response.json();
  }

  async getHealth() {
    const response = await fetch(`${this.serviceUrl}/health`);
    return await response.json();
  }

  async getStats() {
    const response = await fetch(`${this.serviceUrl}/api/v1/stats`, {
      headers: {
        'Authorization': `Bearer ${this.authToken}`
      }
    });
    return await response.json();
  }
}

// Initialize CDP client
const cdpClient = new CdpServiceClient({
  serviceUrl: process.env.CDP_SERVICE_URL || 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN || 'test-token-123',
  defaultTimeout: 30000
});

// Create MCP server
const server = new Server(
  {
    name: "openclaw-browser",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const TOOLS = [
  {
    name: "browser_evaluate",
    description: "Execute JavaScript code in the browser context. Returns the evaluation result.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "JavaScript code to execute in the browser"
        },
        agentId: {
          type: "string",
          description: "Optional agent identifier for session isolation (default: 'mcp-agent')"
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)"
        },
        awaitPromise: {
          type: "boolean",
          description: "Whether to await Promise results (default: true)"
        }
      },
      required: ["expression"]
    }
  },
  {
    name: "browser_navigate",
    description: "Navigate the browser to a specific URL",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to"
        },
        agentId: {
          type: "string",
          description: "Optional agent identifier (default: 'mcp-agent')"
        },
        waitForLoad: {
          type: "boolean",
          description: "Wait for page load completion (default: true)"
        }
      },
      required: ["url"]
    }
  },
  {
    name: "browser_click",
    description: "Click an element on the page by CSS selector",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the element to click"
        },
        agentId: {
          type: "string",
          description: "Optional agent identifier"
        }
      },
      required: ["selector"]
    }
  },
  {
    name: "browser_fill",
    description: "Fill an input field with text",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the input field"
        },
        value: {
          type: "string",
          description: "Text value to fill"
        },
        agentId: {
          type: "string",
          description: "Optional agent identifier"
        }
      },
      required: ["selector", "value"]
    }
  },
  {
    name: "browser_snapshot",
    description: "Get a snapshot of the current page state (HTML, URL, cookies)",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Optional agent identifier"
        },
        includeHtml: {
          type: "boolean",
          description: "Include full HTML (default: true)"
        },
        includeCookies: {
          type: "boolean",
          description: "Include cookies (default: true)"
        }
      }
    }
  },
  {
    name: "browser_extract",
    description: "Extract data from the page using CSS selectors",
    inputSchema: {
      type: "object",
      properties: {
        selectors: {
          type: "object",
          description: "Map of field names to CSS selectors",
          additionalProperties: {
            type: "string"
          }
        },
        agentId: {
          type: "string",
          description: "Optional agent identifier"
        }
      },
      required: ["selectors"]
    }
  },
  {
    name: "browser_wait",
    description: "Wait for an element to appear or a condition to be met",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to wait for (optional if condition is provided)"
        },
        condition: {
          type: "string",
          description: "JavaScript expression that should evaluate to true (optional)"
        },
        timeoutMs: {
          type: "number",
          description: "Maximum wait time in milliseconds (default: 30000)"
        },
        agentId: {
          type: "string",
          description: "Optional agent identifier"
        }
      }
    }
  },
  {
    name: "browser_health",
    description: "Check the health status of the CDP service",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS
}));

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "browser_evaluate":
        const evalResult = await cdpClient.evaluate({
          agentId: args.agentId,
          expression: args.expression,
          awaitPromise: args.awaitPromise,
          budget: { timeoutMs: args.timeoutMs }
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(evalResult, null, 2)
            }
          ]
        };

      case "browser_navigate":
        const navExpression = args.waitForLoad !== false
          ? `
            window.location.href = '${args.url}';
            await new Promise(resolve => {
              if (document.readyState === 'complete') resolve();
              else window.addEventListener('load', resolve);
            });
          `
          : `window.location.href = '${args.url}'`;

        await cdpClient.evaluate({
          agentId: args.agentId,
          expression: navExpression,
          budget: { timeoutMs: 10000 }
        });
        return {
          content: [{ type: "text", text: `Navigated to ${args.url}` }]
        };

      case "browser_click":
        await cdpClient.evaluate({
          agentId: args.agentId,
          expression: `document.querySelector('${args.selector}').click()`
        });
        return {
          content: [{ type: "text", text: `Clicked element: ${args.selector}` }]
        };

      case "browser_fill":
        await cdpClient.evaluate({
          agentId: args.agentId,
          expression: `
            const el = document.querySelector('${args.selector}');
            el.value = '${args.value}';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          `
        });
        return {
          content: [{ type: "text", text: `Filled ${args.selector} with "${args.value}"` }]
        };

      case "browser_snapshot":
        const snapshotExpr = `
          ({
            url: window.location.href,
            title: document.title,
            ${args.includeHtml !== false ? 'html: document.documentElement.outerHTML,' : ''}
            ${args.includeCookies !== false ? 'cookies: document.cookie,' : ''}
            readyState: document.readyState
          })
        `;
        const snapshot = await cdpClient.evaluate({
          agentId: args.agentId,
          expression: snapshotExpr
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(snapshot.result, null, 2)
            }
          ]
        };

      case "browser_extract":
        const extractExpr = `
          ({
            ${Object.entries(args.selectors)
              .map(([key, selector]) =>
                `"${key}": document.querySelector('${selector}')?.textContent?.trim() || null`
              )
              .join(',\n')}
          })
        `;
        const extracted = await cdpClient.evaluate({
          agentId: args.agentId,
          expression: extractExpr
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(extracted.result, null, 2)
            }
          ]
        };

      case "browser_wait":
        let waitExpr;
        if (args.selector) {
          waitExpr = `
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Timeout waiting for selector')), ${args.timeoutMs || 30000});
              const check = () => {
                if (document.querySelector('${args.selector}')) {
                  clearTimeout(timeout);
                  resolve();
                } else {
                  setTimeout(check, 100);
                }
              };
              check();
            });
          `;
        } else if (args.condition) {
          waitExpr = `
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Timeout waiting for condition')), ${args.timeoutMs || 30000});
              const check = () => {
                if (${args.condition}) {
                  clearTimeout(timeout);
                  resolve();
                } else {
                  setTimeout(check, 100);
                }
              };
              check();
            });
          `;
        } else {
          throw new Error('Either selector or condition must be provided');
        }

        await cdpClient.evaluate({
          agentId: args.agentId,
          expression: waitExpr,
          budget: { timeoutMs: (args.timeoutMs || 30000) + 1000 }
        });
        return {
          content: [{ type: "text", text: "Wait condition met" }]
        };

      case "browser_health":
        const health = await cdpClient.getHealth();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(health, null, 2)
            }
          ]
        };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`
        }
      ],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("OpenClaw Browser MCP Server running on stdio");
  console.error("CDP Service URL:", process.env.CDP_SERVICE_URL || 'http://localhost:3100');
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
