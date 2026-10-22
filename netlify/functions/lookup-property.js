// netlify/functions/lookup-property.js
//
// Looks up a Property Deals Pipeline record by its canonical Property Code
// (e.g. "HA-NW-QKYUH"). Legacy PKD links use a separate compatibility query.
// and returns ONLY safe, public-facing fields. Never returns financials,
// internal notes, query status, or anything PDF-derived.
//
// Uses raw fetch against Notion's REST API (not the @notionhq/client SDK)
// with API version 2025-09-03, because the Property Deals Pipeline database
// has multiple data sources — the older SDK's databases.query() only
// supports single-data-source databases and fails with a validation_error
// ("Databases with multiple data sources are not supported in this API
// version"). The 2025-09-03 data-source query endpoint handles multi-source
// databases correctly.
//
// Requires environment variable NOTION_TOKEN (Notion internal integration
// secret) to be set in Netlify site settings. The integration must be
// shared/granted access to the Property Deals Pipeline database in Notion
// (via its ••• menu → Connections → PK Register Site).
//
// Property Code is the canonical text field. Legacy Property ID is a separate
// numeric field and is queried only for an explicit PKD-XX compatibility link.

const NOTION_API_VERSION = "2025-09-03";
const NOTION_API_BASE = "https://api.notion.com/v1";

// Property Deals Pipeline's main data source (the "New Deals"/active deals
// data source).
const PIPELINE_DATA_SOURCE_ID = "fefec549-07c4-46a6-b932-cd05a38e0e92";
const PROPERTY_CODE_PATTERN = /^[A-Z]{2,3}-[A-Z]{2}-[A-Z0-9]{5}$/;
const LEGACY_PROPERTY_CODE_PATTERN = /^PKD-(\d+)$/;

async function notionRequest(path, token, options = {}) {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `Notion API error (${res.status})`);
    err.status = res.status;
    err.code = body.code;
    err.body = body;
    throw err;
  }
  return body;
}

function getText(prop) {
  if (!prop) return null;
  if (prop.type === "title") return (prop.title || []).map((t) => t.plain_text).join("");
  if (prop.type === "rich_text") return (prop.rich_text || []).map((t) => t.plain_text).join("");
  if (prop.type === "select") return prop.select ? prop.select.name : null;
  if (prop.type === "multi_select") return (prop.multi_select || []).map((o) => o.name);
  if (prop.type === "url") return prop.url;
  if (prop.type === "number") return prop.number;
  if (prop.type === "unique_id") {
    if (!prop.unique_id) return null;
    const { prefix, number } = prop.unique_id;
    return prefix ? `${prefix}-${number}` : String(number);
  }
  return null;
}

function getLegacyPropertyIdNumber(prop) {
  if (!prop) return null;
  if (prop.type === "unique_id") {
    const value = prop.unique_id || {};
    const number = Number(value.number);
    return String(value.prefix || "").toUpperCase() === "PKD" && Number.isSafeInteger(number)
      ? number
      : null;
  }
  // Retain compatibility with installations where the field is a plain number.
  if (prop.type === "number" && Number.isSafeInteger(prop.number)) return prop.number;
  return null;
}

function parsePropertyIdentifier(value) {
  const code = String(value || "").trim().toUpperCase();
  if (PROPERTY_CODE_PATTERN.test(code)) return { type: "current", code };
  const legacyMatch = code.match(LEGACY_PROPERTY_CODE_PATTERN);
  if (legacyMatch) return { type: "legacy", code, number: Number(legacyMatch[1]) };
  return null;
}

function isSafePropertyUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const allowedHosts = new Set(["www.propertykickstart.co.uk", "propertykickstart.co.uk"]);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || !/^\/listing\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
    if (url.username || url.password || url.port) return null;
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return null;
  }
}

async function findPipelinePage(token, identifier) {
  const filter = identifier.type === "current"
    ? { property: "Property Code", rich_text: { equals: identifier.code } }
    : { property: "Legacy Property ID", unique_id: { equals: identifier.number } };
  const response = await notionRequest(
    `/data_sources/${PIPELINE_DATA_SOURCE_ID}/query`,
    token,
    { method: "POST", body: JSON.stringify({ filter, page_size: 1 }) }
  );
  const page = (response.results || [])[0];
  if (!page) return null;

  const props = page.properties || {};
  const canonicalCode = String(getText(props["Property Code"]) || "").trim().toUpperCase();
  if (!PROPERTY_CODE_PATTERN.test(canonicalCode)) return null;
  if (identifier.type === "current") {
    if (canonicalCode !== identifier.code) return null;
  } else {
    if (getLegacyPropertyIdNumber(props["Legacy Property ID"]) !== identifier.number) return null;
  }
  return page;
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  const propertyCodeRaw = (event.queryStringParameters || {}).property;

  if (propertyCodeRaw === undefined || propertyCodeRaw === null) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ found: false, reason: "no_code_provided" }),
    };
  }

  const identifier = parsePropertyIdentifier(propertyCodeRaw);
  if (!String(propertyCodeRaw).trim() || !identifier) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ found: false, reason: "invalid_code_format" }),
    };
  }

  if (!process.env.NOTION_TOKEN) {
    console.error("NOTION_TOKEN environment variable is not set");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ found: false, reason: "server_misconfigured" }),
    };
  }

  try {
    const page = await findPipelinePage(process.env.NOTION_TOKEN, identifier);
    if (!page) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ found: false, reason: "not_found" }),
      };
    }

    const props = page.properties || {};

    const availability = getText(props["Availability"]);
    const propertyUrl = isSafePropertyUrl(getText(props["Property URL"]));

    // Safe, public-facing fields only. Never include financials, Notes,
    // Query Notes/Status, Reservation Notes, Reserved By, or any Calc/PDF field.
    const safeData = {
      found: true,
      propertyCode: getText(props["Property Code"]) || null,
      propertyName: getText(props["Property Name"]),
      town: getText(props["Town"]),
      strategy: getText(props["Strategy"]),
      propertyType: getText(props["Property Type"]),
      bedrooms: getText(props["Bedrooms"]),
      availability, // "Available" | "Reserved" | "Sold"
      isLive: availability === "Available",
      propertyUrl: propertyUrl || null,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(safeData),
    };
  } catch (err) {
    console.error("Notion lookup error:", err.status, err.code, err.message);
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ found: false, reason: "lookup_unavailable" }),
    };
  }
};


