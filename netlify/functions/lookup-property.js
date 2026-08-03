// netlify/functions/lookup-property.js
//
// Looks up a Property Deals Pipeline record by Property Code (e.g. "PKD-71")
// and returns ONLY safe, public-facing fields. Never returns financials,
// internal notes, query status, or anything PDF-derived.
//
// Requires environment variable NOTION_TOKEN (Notion internal integration
// secret) to be set in Netlify site settings. The integration must be
// shared/granted access to the Property Deals Pipeline database in Notion.

const { Client } = require("@notionhq/client");

const PIPELINE_DATA_SOURCE_ID = "fefec549-07c4-46a6-b932-cd05a38e0e92";

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

  const notion = new Client({ auth: process.env.NOTION_TOKEN });
  const code = propertyCode.trim().toUpperCase();

  try {
    const response = await notion.dataSources.query({
      data_source_id: PIPELINE_DATA_SOURCE_ID,
      filter: {
        property: "Property Code",
        rich_text: { equals: code },
      },
      page_size: 1,
    });

    if (!response.results || response.results.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ found: false, reason: "not_found", code }),
      };
    }

    const page = response.results[0];
    const props = page.properties;

    const getText = (prop) => {
      if (!prop) return null;
      if (prop.type === "title") return (prop.title || []).map((t) => t.plain_text).join("");
      if (prop.type === "rich_text") return (prop.rich_text || []).map((t) => t.plain_text).join("");
      if (prop.type === "select") return prop.select ? prop.select.name : null;
      if (prop.type === "multi_select") return (prop.multi_select || []).map((o) => o.name);
      if (prop.type === "url") return prop.url;
      if (prop.type === "number") return prop.number;
      return null;
    };

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
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(safeData),
    };
  } catch (err) {
    console.error("Notion lookup error:", err);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ found: false, reason: "lookup_error" }),
    };
  }
};
