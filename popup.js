const DEFAULTS = {
  provider: "openai",
  apiKey: "",
  model: "gpt-4o-mini",
  maxTokens: 40
};

const els = {
  provider: document.getElementById("provider"),
  model: document.getElementById("model"),
  apiKey: document.getElementById("apiKey"),
  maxTokens: document.getElementById("maxTokens"),
  save: document.getElementById("save"),
  status: document.getElementById("status")
};

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  els.provider.value = settings.provider;
  els.model.value = settings.model;
  els.apiKey.value = settings.apiKey;
  els.maxTokens.value = settings.maxTokens;
}

const PROVIDER_DEFAULTS = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-2.5-flash"
};

els.provider.addEventListener("change", () => {
  els.model.value = PROVIDER_DEFAULTS[els.provider.value] ?? "gpt-4o-mini";
});

els.save.addEventListener("click", async () => {
  await chrome.storage.sync.set({
    provider: els.provider.value,
    model: els.model.value.trim() || DEFAULTS.model,
    apiKey: els.apiKey.value.trim(),
    maxTokens: Number(els.maxTokens.value) || DEFAULTS.maxTokens
  });
  els.status.textContent = "Saved ✓";
  setTimeout(() => (els.status.textContent = ""), 1500);
});

load();
