"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, beforeEach, afterEach } = require("node:test");

const { handler: lookupProperty } = require("../netlify/functions/lookup-property.js");
const { handler: register } = require("../netlify/functions/register.js");

const PIPELINE_ID = "fefec549-07c4-46a6-b932-cd05a38e0e92";
const INVESTORS_ID = "0c8ed56c-8c78-40ba-9f44-b8e8c97d0aec";
const PROPERTY_CODE = "HA-NW-8GQ5C";
const PROPERTY_URL = "https://www.propertykickstart.co.uk/listing/69a1ac1817468fa586134172";
const WITHDRAWN_CODE = "HA-NW-QKYUH";
const WITHDRAWN_URL = "https://www.propertykickstart.co.uk/listing/69a565dd17468fa58614909b";
const originalFetch = global.fetch;
const originalNotionToken = process.env.NOTION_TOKEN;
const originalBrevoKey = process.env.PK_Register_Brevo_Key;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function richText(value) {
  return { type: "rich_text", rich_text: [{ plain_text: value }] };
}

function text(value) {
  return { type: "rich_text", rich_text: [{ plain_text: value }] };
}

function samplePipelinePage(overrides = {}) {
  return {
    id: "pipeline-page-1",
    properties: {
      "Property Code": richText(PROPERTY_CODE),
      "Legacy Property ID": { type: "unique_id", unique_id: { prefix: "PKD", number: 35 } },
      "Property Name": text("16, Feltons, Skelmersdale, WN8 6RP"),
      Town: text("Skelmersdale"),
      Strategy: { type: "select", select: { name: "Housing Association" } },
      "Property Type": { type: "select", select: { name: "Terraced" } },
      Bedrooms: { type: "number", number: 3 },
      Availability: { type: "select", select: { name: "Available" } },
      "Property URL": { type: "url", url: PROPERTY_URL },
      "Main Photo URL": { type: "url", url: "https://images.example/property.jpg" },
      "Internal Notes": text("must not be returned"),
      "Monthly Rent": { type: "number", number: 1000 },
      ...overrides,
    },
  };
}

beforeEach(() => {
  process.env.NOTION_TOKEN = "test-notion-token";
  process.env.PK_Register_Brevo_Key = "test-brevo-key";
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalNotionToken === undefined) delete process.env.NOTION_TOKEN;
  else process.env.NOTION_TOKEN = originalNotionToken;
  if (originalBrevoKey === undefined) delete process.env.PK_Register_Brevo_Key;
  else process.env.PK_Register_Brevo_Key = originalBrevoKey;
});

test("lookup normalises and exactly matches the current text Property Code, returning safe context only", async () => {
  let query;
  global.fetch = async (url, options) => {
    query = JSON.parse(options.body);
    return jsonResponse({ results: [samplePipelinePage()] });
  };

  const result = await lookupProperty({ queryStringParameters: { property: " ha-nw-8gq5c " } });
  const body = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(query.filter, { property: "Property Code", rich_text: { equals: PROPERTY_CODE } });
  assert.equal(body.found, true);
  assert.equal(body.propertyCode, PROPERTY_CODE);
  assert.equal(body.propertyUrl, PROPERTY_URL);
  assert.equal(body.isLive, true);
  assert.equal("pageId" in body, false);
  assert.equal(JSON.stringify(body).includes("must not be returned"), false);
  assert.equal(JSON.stringify(body).includes("Monthly Rent"), false);
});

test("lookup keeps legacy PKD support separate on the Legacy Property ID unique ID field", async () => {
  let query;
  global.fetch = async (url, options) => {
    query = JSON.parse(options.body);
    return jsonResponse({ results: [samplePipelinePage()] });
  };

  const result = await lookupProperty({ queryStringParameters: { property: "PKD-35" } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(query.filter, { property: "Legacy Property ID", unique_id: { equals: 35 } });
  assert.equal(JSON.parse(result.body).propertyCode, PROPERTY_CODE);
});

test("legacy lookup rejects a Legacy Property ID with a different prefix", async () => {
  const page = samplePipelinePage({
    "Legacy Property ID": { type: "unique_id", unique_id: { prefix: "OTHER", number: 35 } },
  });
  global.fetch = async () => jsonResponse({ results: [page] });
  const result = await lookupProperty({ queryStringParameters: { property: "PKD-35" } });
  assert.equal(result.statusCode, 404);
  assert.equal(JSON.parse(result.body).reason, "not_found");
});

test("lookup rejects invalid or blank property parameters without querying Pipeline", async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return jsonResponse({ results: [] }); };
  const invalid = await lookupProperty({ queryStringParameters: { property: "71" } });
  const blank = await lookupProperty({ queryStringParameters: { property: " " } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(blank.statusCode, 400);
  assert.equal(calls, 0);
});

test("lookup distinguishes a genuine no-code visit from a failed property-specific lookup", async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return jsonResponse({ results: [] }); };
  const general = await lookupProperty({ queryStringParameters: {} });
  const missing = await lookupProperty({ queryStringParameters: { property: PROPERTY_CODE } });
  assert.equal(general.statusCode, 200);
  assert.equal(JSON.parse(general.body).reason, "no_code_provided");
  assert.equal(missing.statusCode, 404);
  assert.equal(JSON.parse(missing.body).reason, "not_found");
  assert.equal(calls, 1);
});

test("the superseded HA-NW-QKYUH acceptance property resolves but is not treated as live", async () => {
  const page = samplePipelinePage({
    "Property Code": richText(WITHDRAWN_CODE),
    "Legacy Property ID": { type: "unique_id", unique_id: { prefix: "PKD", number: 26 } },
    "Property Name": text("19, Edge Street, St Helens, WA9 5JY"),
    Town: text("St Helens"),
    Availability: { type: "select", select: { name: "Withdrawn" } },
    "Property URL": { type: "url", url: WITHDRAWN_URL },
  });
  global.fetch = async () => jsonResponse({ results: [page] });
  const lookup = await lookupProperty({ queryStringParameters: { property: WITHDRAWN_CODE } });
  const context = JSON.parse(lookup.body);
  assert.equal(context.found, true);
  assert.equal(context.isLive, false);
  assert.equal(context.propertyUrl, WITHDRAWN_URL);

  const calls = registerMockFetch({ pipelinePage: page });
  const registration = await register(registerEvent({ propertyCode: WITHDRAWN_CODE }));
  const body = JSON.parse(registration.body);
  assert.equal(registration.statusCode, 200);
  assert.equal(body.redirectTo, null);
  assert.equal(body.isLive, false);
  assert.equal(calls.some((call) => call.url === "https://api.notion.com/v1/pages"), true);
});

test("lookup suppresses unsafe targets and strips query parameters from listing URLs", async () => {
  const page = samplePipelinePage({ "Property URL": { type: "url", url: `${PROPERTY_URL}?redirect=https://attacker.example/` } });
  global.fetch = async () => jsonResponse({ results: [page] });
  const result = await lookupProperty({ queryStringParameters: { property: PROPERTY_CODE } });
  assert.equal(JSON.parse(result.body).propertyUrl, PROPERTY_URL);
  const unsafePage = samplePipelinePage({ "Property URL": { type: "url", url: "https://attacker.example/collect" } });
  global.fetch = async () => jsonResponse({ results: [unsafePage] });
  const unsafeResult = await lookupProperty({ queryStringParameters: { property: PROPERTY_CODE } });
  assert.equal(JSON.parse(unsafeResult.body).propertyUrl, null);
});

function registerMockFetch({ pipelinePage = samplePipelinePage(), existingInvestor = null } = {}) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    if (call.url.includes(`/data_sources/${PIPELINE_ID}/query`)) return jsonResponse({ results: pipelinePage ? [pipelinePage] : [] });
    if (call.url.includes(`/data_sources/${INVESTORS_ID}/query`)) return jsonResponse({ results: existingInvestor ? [existingInvestor] : [] });
    if (call.url === "https://api.brevo.com/v3/contacts") return jsonResponse({}, 201);
    if (call.url === "https://api.notion.com/v1/pages" || call.url.includes("https://api.notion.com/v1/pages/")) return jsonResponse({ id: "investor-page-1" });
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  };
  return calls;
}

function registerEvent(data) {
  return { httpMethod: "POST", body: JSON.stringify({ firstName: "Hanna", email: "hanna@example.test", ...data }) };
}

test("registration stores canonical code, CRM relation and attribution, then returns only the matched listing URL", async () => {
  const calls = registerMockFetch();
  const result = await register(registerEvent({
    propertyCode: " ha-nw-8gq5c ",
    source: "linkedin",
    campaign: "october-property-post",
    utmSource: "linkedin",
    utmMedium: "social",
    utmCampaign: "october-property-post",
    landingPageUrl: "https://register.propertykickstart.co.uk/?property=HA-NW-8GQ5C&utm_source=linkedin",
    redirectTo: "https://attacker.example/",
  }));
  const body = JSON.parse(result.body);
  const pipelineQuery = calls.find((call) => call.url.includes(`/data_sources/${PIPELINE_ID}/query`));
  const brevo = calls.find((call) => call.url === "https://api.brevo.com/v3/contacts").body;
  const crmCreate = calls.find((call) => call.url === "https://api.notion.com/v1/pages").body;
  const crmProperties = crmCreate.properties;

  assert.equal(result.statusCode, 200);
  assert.equal(body.redirectTo, PROPERTY_URL);
  assert.equal(body.registrationType, "Property-Specific");
  assert.deepEqual(pipelineQuery.body.filter, { property: "Property Code", rich_text: { equals: PROPERTY_CODE } });
  assert.equal(brevo.attributes.PROPERTY_CODE, PROPERTY_CODE);
  assert.equal(brevo.attributes.PROPERTY_URL, PROPERTY_URL);
  assert.equal(brevo.attributes.SOURCE_PLATFORM, "linkedin");
  assert.equal(brevo.attributes.CAMPAIGN_ID, "october-property-post");
  assert.equal(crmProperties["Property Code Entered"].rich_text[0].text.content, PROPERTY_CODE);
  assert.deepEqual(crmProperties["Deals Shared"].relation, [{ id: "pipeline-page-1" }]);
  assert.equal(crmProperties["UTM Source"].rich_text[0].text.content, "linkedin");
  assert.equal(crmProperties["UTM Medium"].rich_text[0].text.content, "social");
  assert.equal(crmProperties["UTM Campaign"].rich_text[0].text.content, "october-property-post");
  assert.equal(crmProperties["Landing Page URL"].url.includes("utm_source=linkedin"), true);
});

test("invalid and unresolved property codes fail closed before Brevo or CRM writes", async () => {
  let calls = [];
  global.fetch = async (...args) => { calls.push(args); return jsonResponse({ results: [] }); };
  const invalid = await register(registerEvent({ propertyCode: "71" }));
  assert.equal(invalid.statusCode, 400);
  assert.equal(calls.length, 0);

  calls = registerMockFetch({ pipelinePage: null });
  const unresolved = await register(registerEvent({ propertyCode: PROPERTY_CODE }));
  assert.equal(unresolved.statusCode, 404);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes(`/data_sources/${PIPELINE_ID}/query`), true);
});

test("a property-specific landing URL cannot be submitted as a general registration", async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return jsonResponse({ results: [] }); };
  const result = await register(registerEvent({
    propertyCode: "",
    landingPageUrl: "https://register.propertykickstart.co.uk/?property=HA-NW-QKYUH",
  }));
  assert.equal(result.statusCode, 400);
  assert.equal(calls, 0);
});

test("legacy registration resolves the unique ID and stores the canonical Property Code", async () => {
  const calls = registerMockFetch();
  const result = await register(registerEvent({ propertyCode: "PKD-35", source: "whatsapp" }));
  const query = calls.find((call) => call.url.includes(`/data_sources/${PIPELINE_ID}/query`));
  const crmCreate = calls.find((call) => call.url === "https://api.notion.com/v1/pages").body;
  const brevo = calls.find((call) => call.url === "https://api.brevo.com/v3/contacts").body;
  assert.equal(result.statusCode, 200);
  assert.deepEqual(query.body.filter, { property: "Legacy Property ID", unique_id: { equals: 35 } });
  assert.equal(crmCreate.properties["Property Code Entered"].rich_text[0].text.content, PROPERTY_CODE);
  assert.equal(brevo.attributes.PROPERTY_CODE, PROPERTY_CODE);
});

test("existing investor deal relationships are retained when a new property is registered", async () => {
  const existingInvestor = {
    id: "investor-existing",
    properties: { "Deals Shared": { relation: [{ id: "previous-deal" }] } },
  };
  const calls = registerMockFetch({ existingInvestor });
  const result = await register(registerEvent({ propertyCode: PROPERTY_CODE }));
  const update = calls.find((call) => call.url === "https://api.notion.com/v1/pages/investor-existing");
  assert.equal(result.statusCode, 200);
  assert.deepEqual(update.body.properties["Deals Shared"].relation, [
    { id: "previous-deal" },
    { id: "pipeline-page-1" },
  ]);
});

test("missing or unsafe Pipeline URL records the lead without redirecting and reports the issue", async () => {
  const page = samplePipelinePage({ "Property URL": { type: "url", url: "https://attacker.example/" } });
  const calls = registerMockFetch({ pipelinePage: page });
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await register(registerEvent({ propertyCode: PROPERTY_CODE }));
    const body = JSON.parse(result.body);
    const crmCreate = calls.find((call) => call.url === "https://api.notion.com/v1/pages").body;
    assert.equal(result.statusCode, 200);
    assert.equal(body.redirectTo, null);
    assert.equal(body.issue, "property_url_unavailable");
    assert.equal("Property URL at Submission" in crmCreate.properties, false);
  } finally {
    console.error = originalError;
  }
});

test("no-code registration remains a genuine general alert registration", async () => {
  const calls = registerMockFetch({ pipelinePage: null });
  const result = await register(registerEvent({ propertyCode: "" }));
  const body = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);
  assert.equal(body.registrationType, "General Alert Only");
  assert.equal(body.redirectTo, null);
  assert.equal(calls.some((call) => call.url.includes(`/data_sources/${PIPELINE_ID}/query`)), false);
});

function createElement() {
  const classes = new Set();
  return {
    value: "",
    textContent: "",
    src: "",
    disabled: false,
    style: {},
    listeners: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener: function (name, handler) { this.listeners[name] = handler; },
  };
}

async function runRegistrationPage(search, fetchImpl) {
  const ids = ["propertyCode", "property-context", "pc-photo", "pc-title", "pc-meta", "pc-unavailable", "registration-form", "submit-btn", "form-error-banner", "firstName", "email", "field-firstName", "field-email", "field-property", "form-view", "confirmation"];
  const elements = Object.fromEntries(ids.map((id) => [id, createElement()]));
  const confirmationTitle = createElement();
  const confirmationIntro = createElement();
  const document = {
    getElementById: (id) => elements[id],
    querySelector: (selector) => selector === "#confirmation h1" ? confirmationTitle : confirmationIntro,
  };
  const window = { location: { search, href: "https://register.propertykickstart.co.uk/" } };
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { document, window, URLSearchParams, fetch: fetchImpl, console });
  await new Promise(setImmediate);
  return { elements, window, confirmationTitle, confirmationIntro };
}

test("property-specific page auto-carries a normalised code and redirects after successful registration", async () => {
  const calls = [];
  const page = await runRegistrationPage(
    "?property=%20ha-nw-8gq5c%20&source=instagram&campaign=autumn&utm_source=instagram&utm_medium=social&utm_campaign=autumn",
    async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes("lookup-property")) return { ok: true, json: async () => ({ found: true, propertyCode: PROPERTY_CODE, propertyName: "16, Feltons, Skelmersdale, WN8 6RP", town: "Skelmersdale", strategy: "Housing Association", isLive: true }) };
      return { ok: true, json: async () => ({ success: true, redirectTo: PROPERTY_URL }) };
    }
  );
  assert.equal(page.elements.propertyCode.value, PROPERTY_CODE);
  assert.equal(page.elements["field-property"].style.display, "none");
  assert.equal(page.elements["submit-btn"].disabled, false);
  page.elements.firstName.value = "Hanna";
  page.elements.email.value = "hanna@example.test";
  page.elements["registration-form"].listeners.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  const submission = JSON.parse(calls.find((call) => call.url.endsWith("/register")).options.body);
  assert.equal(submission.propertyCode, PROPERTY_CODE);
  assert.equal(submission.source, "instagram");
  assert.equal(submission.campaign, "autumn");
  assert.equal(submission.utmSource, "instagram");
  assert.equal(submission.utmMedium, "social");
  assert.equal(submission.utmCampaign, "autumn");
  assert.equal(page.window.location.href, PROPERTY_URL);
});

test("invalid property-specific route is blocked instead of becoming a general registration", async () => {
  let calls = 0;
  const page = await runRegistrationPage("?property=not-a-property-code", async () => { calls += 1; return jsonResponse({}); });
  page.elements.firstName.value = "Hanna";
  page.elements.email.value = "hanna@example.test";
  page.elements["registration-form"].listeners.submit({ preventDefault() {} });
  assert.equal(calls, 0);
  assert.equal(page.elements["submit-btn"].disabled, true);
  assert.equal(page.elements["form-error-banner"].classList.contains("show"), true);
});

test("mobile layout viewport and current Property code wording are present", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
  assert.match(html, /<label for="propertyCode">Property code/);
  assert.match(html, /placeholder="e\.g\. BTL-NW-3GF2B"/);
  assert.doesNotMatch(html, /Property Registration ID|PKD-71/);
});
