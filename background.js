// background.js
// Service worker: owns the API key, talks to the LLM, returns plain completion text.
// Keeping this out of content.js means the API key is never exposed to the page's JS context.

const DEFAULT_SETTINGS = {
  provider: "openai", // "openai" | "anthropic"
  apiKey: "",
  model: "gpt-4o-mini",
  maxTokens: 40
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// Simple in-memory cache so retyping the same prefix doesn't re-hit the API.
const completionCache = new Map();
const CACHE_MAX = 200;

function cacheGet(key) {
  return completionCache.get(key);
}
function cacheSet(key, value) {
  if (completionCache.size >= CACHE_MAX) {
    const firstKey = completionCache.keys().next().value;
    completionCache.delete(firstKey);
  }
  completionCache.set(key, value);
}

async function fetchOpenAICompletion({ apiKey, model, maxTokens, textBeforeCursor, textAfterCursor }) {
  const systemPrompt =
    "You are an inline autocomplete engine, like GitHub Copilot but for prose. " +
    "Given the text immediately before the user's cursor (and a little after it for context), " +
    "predict ONLY the text that should be inserted at the cursor to naturally continue it. " +
    "Rules: continue the current word/sentence naturally; do not repeat any of the given text; " +
    "keep it short (a phrase, clause, or one sentence at most); no quotes, no markdown, no explanations; " +
    "if nothing sensible completes the thought, return an empty string.";

  const userPrompt =
    `TEXT BEFORE CURSOR:\n"""${textBeforeCursor.slice(-800)}"""\n\n` +
    `TEXT AFTER CURSOR:\n"""${textAfterCursor.slice(0, 200)}"""\n\n` +
    `Return only the continuation text, nothing else.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_tokens: maxTokens,
      temperature: 0.2
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function fetchAnthropicCompletion({ apiKey, model, maxTokens, textBeforeCursor, textAfterCursor }) {
  const systemPrompt =
    "You are an inline autocomplete engine, like GitHub Copilot but for prose. " +
    "Given text before and after the user's cursor, predict ONLY the continuation text to insert " +
    "at the cursor. Keep it short (phrase to one sentence). No quotes, no markdown, no preamble. " +
    "Never repeat the given text. If nothing fits, return an empty string.";

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content:
            `TEXT BEFORE CURSOR:\n"""${textBeforeCursor.slice(-800)}"""\n\n` +
            `TEXT AFTER CURSOR:\n"""${textAfterCursor.slice(0, 200)}"""\n\n` +
            `Return only the continuation text.`
        }
      ]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text?.trim() ?? "";
}

async function fetchGeminiCompletion({ apiKey, model, maxTokens, textBeforeCursor, textAfterCursor }) {
  const prompt =
    "You are an inline autocomplete engine. Given text before and after the cursor, " +
    "predict ONLY the continuation text to insert at the cursor. Keep it short (phrase to one sentence). " +
    "No quotes, no markdown, no preamble. Never repeat the given text. If nothing fits, return an empty string.\n\n" +
    `TEXT BEFORE CURSOR:\n"""${textBeforeCursor.slice(-800)}"""\n\n` +
    `TEXT AFTER CURSOR:\n"""${textAfterCursor.slice(0, 200)}"""\n\n` +
    `Return only the continuation text.`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 }
      })
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
}

async function getCompletion({ textBeforeCursor, textAfterCursor }) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { error: "NO_API_KEY" };
  }

  const cacheKey = `${settings.provider}:${settings.model}:${textBeforeCursor.slice(-800)}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    return { text: cached, cached: true };
  }

  try {
    const fn =
      settings.provider === "anthropic" ? fetchAnthropicCompletion :
      settings.provider === "gemini" ? fetchGeminiCompletion :
      fetchOpenAICompletion;
    const text = await fn({
      apiKey: settings.apiKey,
      model: settings.model,
      maxTokens: settings.maxTokens,
      textBeforeCursor,
      textAfterCursor
    });
    cacheSet(cacheKey, text);
    return { text };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_COMPLETION") {
    getCompletion(message.payload).then(sendResponse);
    return true; // keep the message channel open for async response
  }
});
