// netlify/functions/lookup-property.js
//
// Looks up a Property Deals Pipeline record by Property Code (e.g. "PKD-71")
// and returns ONLY safe, public-facing fields. Never returns financials,
// internal notes, query status, or anything PDF-derived.
//
// Uses raw fetch against Notion's REST API (not the @notionhq/client SDK)
// with API version 2025-09-03, because the Property Deals Pipeline database
// has multiple data sources — the older SDK's databases.query() only
// supports single-data-source databases and fails with a validation_error
// ("Databases with multiple data sources are not supported in this API
// version") on this database. The 2025-09-03 data-source query endpoint
// handles multi-source databases correctly.
//
// Requires environment variable NOTION_TOKEN (Notion internal integration
// secret) to be set in Netlify site settings. The integration must be
// shared/granted access to the Property Deals Pipeline database in Notion
// (via its ••• menu → Connections → PK Register Site).

const NOTION_API_VERSION = "2025-09-03";
const NOTION_API_BASE = "https://api.notion.com/v1";

// Property Deals Pipeline's main data source (the "New Deals"/active deals
// data source — confirmed via a live record: 138 Hainton Avenue, Grimsby,
// Property Code PKD-71, this data source ID).
const PIPELINE_DATA_SOURCE_ID = "fefec549-07c4-46a6-b932-cd05a38e0e92";

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
  return null;
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  const propertyCode = (event.queryStringParameters || {}).property;

  if (!propertyCode || !propertyCode.trim()) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ found: false, reason: "no_code_provided" }),
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

  const code = propertyCode.trim().toUpperCase();

  try {
    const response = await notionRequest(
      `/data_sources/${PIPELINE_DATA_SOURCE_ID}/query`,
      process.env.NOTION_TOKEN,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            property: "Property Code",
            rich_text: { equals: code },
          },
          page_size: 1,
        }),
      }
    );

    if (!response.results || response.results.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ found: false, reason: "not_found", code }),
      };
    }

    const page = response.results[0];
    const props = page.properties;

    const availability = getText(props["Availability"]);
    const propertyUrl = getText(props["Property URL"]);

    // Safe, public-facing fields only. Never include financials, Notes,
    // Query Notes/Status, Reservation Notes, Reserved By, or any Calc/PDF field.
    const safeData = {
      found: true,
      propertyCode: getText(props["Property Code"]) || code,
      propertyName: getText(props["Property Name"]),
      town: getText(props["Town"]),
      strategy: getText(props["Strategy"]),
      propertyType: getText(props["Property Type"]),
      bedrooms: getText(props["Bedrooms"]),
      availability, // "Available" | "Reserved" | "Sold"
      isLive: availability === "Available",
      propertyUrl: propertyUrl || null,
      mainPhotoUrl: getText(props["Main Photo URL"]) || null,
      pageId: page.id,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(safeData),
    };
  } catch (err) {
    console.error("Notion lookup error:", err.status, err.code, err.message);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ found: false, reason: "lookup_error" }),
    };
  }
};
