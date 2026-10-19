// netlify/functions/register.js
//
// Handles registration form submission:
//   1. Looks up the property (if a code was provided) to confirm it and get
//      its live URL + Notion page id for the relation.
//   2. Creates/updates a Brevo contact (upsert by email) with attribution.
//   3. Finds-or-creates the investor in Notion's Investors DB (CRM) — updates
//      an existing investor record by email rather than duplicating.
//   4. Returns a redirect target (live Property URL) or a flag to show the
//      generic "you're registered" confirmation.
//
// Never fetches, references, or returns any PDF or PDF-derived field.
//
// Uses raw fetch against Notion's REST API (not the @notionhq/client SDK)
// with API version 2025-09-03. The Property Deals Pipeline database has
// multiple data sources, which the older SDK's databases.query() cannot
// handle (fails with validation_error: "Databases with multiple data
// sources are not supported in this API version"). The data-source-specific
// query/create/update endpoints work correctly regardless of whether the
// parent database is single- or multi-source.
//
// Property Code is the canonical text identifier. Legacy Property ID is a
// separate numeric field queried only for explicit PKD-XX compatibility.
//
// Required environment variables (set in Netlify site settings):
//   NOTION_TOKEN            - Notion internal integration secret
//   PK_Register_Brevo_Key   - Brevo API v3 key

const NOTION_API_VERSION = "2025-09-03";
const NOTION_API_BASE = "https://api.notion.com/v1";

// Property Deals Pipeline's main data source.
const PIPELINE_DATA_SOURCE_ID = "fefec549-07c4-46a6-b932-cd05a38e0e92";
// Investors DB is the CRM destination for all registrations (not a separate
// log) — see ACT-572 for the decision to fold registrations into the
// existing Investors DB rather than a standalone Property Registrations DB.
const INVESTORS_DATA_SOURCE_ID = "0c8ed56c-8c78-40ba-9f44-b8e8c97d0aec";
const BREVO_LIST_ID = 8; // "Registrations - Website"
const PROPERTY_CODE_PATTERN = /^[A-Z]{2,3}-[A-Z]{2}-[A-Z0-9]{5}$/;
const LEGACY_PROPERTY_CODE_PATTERN = /^PKD-(\d+)$/;

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

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
  if (prop.type === "url") return prop.url;
  if (prop.type === "number") return prop.number;
  if (prop.type === "unique_id") {
    if (!prop.unique_id) return null;
    const { prefix, number } = prop.unique_id;
    return prefix ? `${prefix}-${number}` : String(number);
  }
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
    : { property: "Legacy Property ID", number: { equals: identifier.number } };
  const response = await notionRequest(
    `/data_sources/${PIPELINE_DATA_SOURCE_ID}/query`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ filter, page_size: 1 }),
    }
  );
  const page = (response.results || [])[0];
  if (!page) return null;

  const props = page.properties || {};
  if (identifier.type === "current") {
    const matchedCode = getText(props["Property Code"]);
    if (String(matchedCode || "").trim().toUpperCase() !== identifier.code) return null;
  } else {
    const legacyNumber = getText(props["Legacy Property ID"]);
    if (Number(legacyNumber) !== identifier.number) return null;
  }
  return page;
}

async function findInvestorByEmail(token, email) {
  const response = await notionRequest(
    `/data_sources/${INVESTORS_DATA_SOURCE_ID}/query`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        filter: { property: "Email", email: { equals: email } },
        page_size: 1,
      }),
    }
  );
  if (!response.results || response.results.length === 0) return null;
  return response.results[0];
}

async function upsertBrevoContact(apiKey, payload) {
  const res = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  // Brevo returns 400 duplicate_parameter if contact exists; treat as success
  // and fall through to an update call.
  if (res.status === 201) return { created: true };
  if (res.status === 204) return { created: false };

  const body = await res.json().catch(() => ({}));
  if (res.status === 400 && body.code === "duplicate_parameter") {
    const updateRes = await fetch(
      `https://api.brevo.com/v3/contacts/${encodeURIComponent(payload.email)}`,
      {
        method: "PUT",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attributes: payload.attributes,
          listIds: payload.listIds,
        }),
      }
    );
    if (updateRes.ok) return { created: false, updated: true };
    throw new Error(`Brevo update failed: ${updateRes.status}`);
  }
  throw new Error(`Brevo create failed: ${res.status} ${JSON.stringify(body)}`);
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const firstName = String(data.firstName || "").trim();
  const email = String(data.email || "").trim().toLowerCase();
  const propertyCodeRaw = String(data.propertyCode || "").trim();
  const submittedPropertyCode = propertyCodeRaw ? propertyCodeRaw.toUpperCase() : "";
  const source = String(data.source || "").trim();
  const campaign = String(data.campaign || "").trim();
  const utmSource = String(data.utmSource || "").trim();
  const utmMedium = String(data.utmMedium || "").trim();
  const utmCampaign = String(data.utmCampaign || "").trim();
  const landingPageUrl = String(data.landingPageUrl || "").trim();

  if (!firstName || !email) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "First name and email are required" }),
    };
  }
  if (!isValidEmail(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid email address" }) };
  }
  const propertyIdentifier = submittedPropertyCode ? parsePropertyIdentifier(submittedPropertyCode) : null;
  if (submittedPropertyCode && !propertyIdentifier) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Enter a valid property code." }) };
  }
  if (landingPageUrl) {
    try {
      const landingUrl = new URL(landingPageUrl);
      if (landingUrl.searchParams.has("property")) {
        const landingCode = String(landingUrl.searchParams.get("property") || "").trim().toUpperCase();
        const landingIdentifier = parsePropertyIdentifier(landingCode);
        if (!propertyIdentifier || !landingIdentifier || landingIdentifier.code !== propertyIdentifier.code) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "This property link is incomplete or no longer valid." }),
          };
        }
      }
    } catch (_) {
      // The landing-page URL is attribution data only; it is never a redirect target.
    }
  }
  if (!process.env.NOTION_TOKEN || !process.env.PK_Register_Brevo_Key) {
    console.error("Missing NOTION_TOKEN or PK_Register_Brevo_Key env vars");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server misconfigured" }) };
  }

  const notionToken = process.env.NOTION_TOKEN;

  // Step 1: resolve property if a code was given
  let pipelinePage = null;
  let propertyUrl = null;
  let isLive = false;
  let registrationType = "General Alert Only";
  let issue = null;
  let propertyCode = "";

  if (propertyIdentifier) {
    try {
      pipelinePage = await findPipelinePage(notionToken, propertyIdentifier);
    } catch (err) {
      console.error("Pipeline lookup failed during registration:", err.status, err.message);
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({ error: "We couldn't verify this property code. Please try again shortly." }),
      };
    }
    if (!pipelinePage) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "We couldn't find this property code. Please check the link and try again." }),
      };
    }

    const pipelineProperties = pipelinePage.properties || {};
    const canonicalCode = String(getText(pipelineProperties["Property Code"]) || "").trim().toUpperCase();
    if (!PROPERTY_CODE_PATTERN.test(canonicalCode)) {
      console.error("Matched property has no valid canonical Property Code:", pipelinePage.id);
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: "This property link needs attention. Please try again later." }),
      };
    }
    propertyCode = canonicalCode;
    const availability = getText(pipelineProperties["Availability"]);
    propertyUrl = isSafePropertyUrl(getText(pipelineProperties["Property URL"]));
    isLive = availability === "Available";
    registrationType = "Property-Specific";
    if (!propertyUrl) {
      issue = "property_url_unavailable";
      console.error("Matched property is missing a safe listing URL:", { propertyCode, pageId: pipelinePage.id });
    }
  }

  // Step 2: upsert Brevo contact
  let brevoSynced = false;
  let brevoError = null;
  try {
    await upsertBrevoContact(process.env.PK_Register_Brevo_Key, {
      email,
      attributes: {
        FIRSTNAME: firstName,
        EMAIL_CONSENT: true,
        OPT_IN: true,
        PROPERTY_CODE: propertyCode,
        PROPERTY_URL: propertyUrl || "",
        SOURCE_PLATFORM: source || "",
        CAMPAIGN_ID: campaign || "",
      },
      listIds: [BREVO_LIST_ID],
      updateEnabled: true,
    });
    brevoSynced = true;
  } catch (err) {
    console.error("Brevo sync failed:", err);
    brevoError = err.message;
  }

  // Step 3: find-or-create the investor record in Investors DB
  const redirectTo = isLive && propertyUrl ? propertyUrl : null;
  let notionError = null;
  try {
    // Find-or-update by email rather than always creating a new investor row.
    const existing = await findInvestorByEmail(notionToken, email);
    const properties = {
      "Full Name": { title: [{ text: { content: firstName } }] },
      Email: { email },
      "Property Code Entered": { rich_text: [{ text: { content: propertyCode } }] },
      Source: { select: { name: "Website" } },
      "Campaign ID": { rich_text: [{ text: { content: campaign } }] },
      "UTM Source": { rich_text: [{ text: { content: utmSource } }] },
      "UTM Medium": { rich_text: [{ text: { content: utmMedium } }] },
      "UTM Campaign": { rich_text: [{ text: { content: utmCampaign } }] },
      "Landing Page URL": landingPageUrl ? { url: landingPageUrl } : undefined,
      "Property URL at Submission": propertyUrl ? { url: propertyUrl } : undefined,
      "Redirected To": redirectTo ? { url: redirectTo } : undefined,
      "Registration Type": { select: { name: registrationType } },
      "Consent Given": { checkbox: true },
      "Submitted At": { date: { start: new Date().toISOString() } },
      "Brevo Contact Synced": { checkbox: brevoSynced },
    };
    if (pipelinePage) {
      const existingDealIds = (existing && existing.properties && existing.properties["Deals Shared"] && existing.properties["Deals Shared"].relation || [])
        .map((relation) => relation.id)
        .filter(Boolean);
      const dealIds = Array.from(new Set([...existingDealIds, pipelinePage.id]));
      properties["Deals Shared"] = { relation: dealIds.map((id) => ({ id })) };
    }
    // Strip undefined keys (Notion API rejects undefined values)
    Object.keys(properties).forEach((k) => properties[k] === undefined && delete properties[k]);

    if (existing) {
      await notionRequest(`/pages/${existing.id}`, notionToken, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });
    } else {
      properties["Status"] = { select: { name: "Warm Lead" } };
      await notionRequest(`/pages`, notionToken, {
        method: "POST",
        body: JSON.stringify({
          parent: { data_source_id: INVESTORS_DATA_SOURCE_ID },
          properties,
        }),
      });
    }
  } catch (err) {
    console.error("Notion investor record failed:", err.status, err.message);
    notionError = err.message;
  }

  // If both systems failed, tell the user something went wrong.
  if (!brevoSynced && notionError) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: "We couldn't complete your registration right now. Please try again shortly.",
      }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      redirectTo, // null if no live property resolved
      isLive,
      registrationType,
      issue,
    }),
  };
};


