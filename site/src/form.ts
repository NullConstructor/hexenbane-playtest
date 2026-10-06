// The application form: live validation, the agreement gate, submission and its outcomes.
// Validation rules come from the same module the Edge Function uses, so both agree.

import {
  FIELD_LABELS,
  FIELD_LIMITS,
  type FieldErrors,
  HONEYPOT_FIELD,
  type SubmitRequestBody,
  type SubmitResponse,
  textLength,
  validateApplication,
} from "@shared/application.ts";
import { config } from "./config.ts";
import { initTurnstile, type CaptchaHandle } from "./turnstile.ts";

type FieldName = keyof FieldErrors;

const REQUEST_TIMEOUT_MS = 20000;

export function initForm(): void {
  const form = document.querySelector<HTMLFormElement>("[data-form]");
  if (!form) return;
  const panel = document.querySelector<HTMLElement>("[data-apply-panel]")!;
  const summary = form.querySelector<HTMLElement>("[data-summary]")!;
  const summaryList = form.querySelector<HTMLUListElement>("[data-summary-list]")!;
  const submit = form.querySelector<HTMLButtonElement>("[data-submit]")!;
  const submitLabel = form.querySelector<HTMLElement>("[data-submit-label]")!;
  const submitHint = form.querySelector<HTMLElement>("[data-submit-hint]")!;
  const failure = form.querySelector<HTMLElement>("[data-failure]")!;
  const failureMessage = form.querySelector<HTMLElement>("[data-failure-message]")!;
  const live = form.querySelector<HTMLElement>("[data-live]")!;
  const success = panel.querySelector<HTMLElement>("[data-success]")!;
  const joined = form.querySelector<HTMLInputElement>("#joinedDiscord")!;
  const agreed = form.querySelector<HTMLInputElement>("#agreementAccepted")!;

  const startedAt = Date.now();
  const touched = new Set<FieldName>();
  let submitting = false;
  let captcha: CaptchaHandle | null = null;
  if (config.turnstileSiteKey) {
    const host = form.querySelector<HTMLElement>("[data-captcha]")!;
    host.hidden = false;
    captcha = initTurnstile(host, config.turnstileSiteKey);
  }

  const control = (name: FieldName) => form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;

  const readValues = () => {
    const text = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "";
    return {
      preferredName: text("preferredName"),
      discordUsername: text("discordUsername"),
      email: text("email"),
      interestReason: text("interestReason"),
      similarGames: text("similarGames"),
      testingExperience: text("testingExperience"),
      cpu: text("cpu"),
      gpu: text("gpu"),
      ram: text("ram"),
      operatingSystem: text("operatingSystem"),
      additionalNotes: text("additionalNotes"),
      joinedDiscord: joined.checked,
      agreementAccepted: agreed.checked,
    };
  };

  const setFieldError = (name: FieldName, message: string | undefined) => {
    const input = control(name);
    const error = form.querySelector<HTMLElement>(`#${name}-error`);
    const wrapper = form.querySelector<HTMLElement>(`[data-field="${name}"]`);
    if (error) error.textContent = message ?? "";
    wrapper?.classList.toggle("is-invalid", Boolean(message));
    if (input) {
      if (message) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  };

  const showErrors = (errors: FieldErrors, only?: Set<FieldName>) => {
    for (const name of Object.keys(FIELD_LABELS) as FieldName[]) {
      if (only && !only.has(name)) continue;
      setFieldError(name, errors[name]);
    }
  };

  const renderSummary = (errors: FieldErrors) => {
    summaryList.replaceChildren();
    for (const [name, message] of Object.entries(errors) as [FieldName, string][]) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#${name}`;
      a.textContent = message;
      a.addEventListener("click", (event) => {
        event.preventDefault();
        const input = control(name);
        input?.focus();
        input?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      li.append(a);
      summaryList.append(li);
    }
    summary.hidden = summaryList.childElementCount === 0;
  };

  const updateCounters = () => {
    for (const counter of form.querySelectorAll<HTMLElement>("[data-count]")) {
      const name = counter.id.replace(/-count$/, "") as keyof typeof FIELD_LIMITS;
      const length = textLength(control(name)?.value ?? "");
      const max = FIELD_LIMITS[name].max;
      counter.textContent = `${length} / ${max}`;
      counter.classList.toggle("is-near", length > max * 0.9);
    }
  };

  const updateGate = () => {
    const open = joined.checked && agreed.checked;
    submit.setAttribute("aria-disabled", String(!open || submitting));
    submitHint.hidden = open;
  };

  const showFailure = (message: string | null) => {
    failure.hidden = !message;
    failureMessage.textContent = message ?? "";
  };

  const setSubmitting = (value: boolean) => {
    submitting = value;
    form.setAttribute("aria-busy", String(value));
    form.classList.toggle("is-submitting", value);
    for (const fieldset of form.querySelectorAll("fieldset")) fieldset.disabled = value;
    submitLabel.textContent = value ? "Submitting…" : "Submit application";
    updateGate();
  };

  // Live validation: a field is checked once it has been left, then on every change after.
  form.addEventListener("focusout", (event) => {
    const name = (event.target as HTMLElement).getAttribute("name") as FieldName | null;
    if (!name || !(name in FIELD_LABELS) || name === "joinedDiscord" || name === "agreementAccepted") return;
    if (!(event.target as HTMLInputElement).value && !touched.has(name)) return;
    touched.add(name);
    const result = validateApplication(readValues());
    showErrors(result.ok ? {} : result.errors, new Set([name]));
  });
  form.addEventListener("input", (event) => {
    updateCounters();
    const name = (event.target as HTMLElement).getAttribute("name") as FieldName | null;
    if (name && touched.has(name)) {
      const result = validateApplication(readValues());
      showErrors(result.ok ? {} : result.errors, new Set([name]));
    }
  });
  form.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target === joined || target === agreed) {
      updateGate();
      if (target.checked) setFieldError(target.name as FieldName, undefined);
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    showFailure(null);

    const values = readValues();
    const result = validateApplication(values);
    if (!result.ok) {
      for (const name of Object.keys(result.errors) as FieldName[]) touched.add(name);
      showErrors(result.errors);
      renderSummary(result.errors);
      summary.focus();
      summary.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    showErrors({});
    renderSummary({});

    if (!config.submitUrl) {
      showFailure("Applications aren't open on this copy of the site yet (VITE_SUPABASE_URL is not configured). Please try again later.");
      return;
    }

    const honeypot = (form.elements.namedItem(HONEYPOT_FIELD) as HTMLInputElement | null)?.value ?? "";
    const body: SubmitRequestBody = {
      ...values,
      [HONEYPOT_FIELD]: honeypot,
      elapsedMs: Date.now() - startedAt,
      ...(captcha ? { captchaToken: captcha.token() ?? "" } : {}),
    };

    setSubmitting(true);
    live.textContent = "Submitting your application.";
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.supabaseAnonKey) {
        headers.apikey = config.supabaseAnonKey;
        headers.Authorization = `Bearer ${config.supabaseAnonKey}`;
      }
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(config.submitUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
          credentials: "omit",
        });
      } finally {
        window.clearTimeout(timer);
      }
      const data = (await response.json().catch(() => null)) as SubmitResponse | null;

      if (response.ok && data?.success) {
        showSuccess(data.applicationId);
        return;
      }
      captcha?.reset();
      if (data && !data.success) {
        if (data.error.fields) {
          showErrors(data.error.fields);
          renderSummary(data.error.fields);
        }
        showFailure(data.error.message);
      } else {
        showFailure("Something went wrong on our side and your application was not sent. Your answers are still here; please try again in a few minutes.");
      }
      live.textContent = "Your application was not sent.";
      (data && !data.success && data.error.fields ? summary : failure).focus();
    } catch (err) {
      captcha?.reset();
      const timedOut = err instanceof DOMException && err.name === "AbortError";
      showFailure(
        timedOut
          ? "The server took too long to answer. Your answers are still here; please try again."
          : "We couldn't reach the server. Check your connection and try again; your answers are still here.",
      );
      live.textContent = "Your application was not sent.";
    } finally {
      if (success.hidden) setSubmitting(false);
    }
  });

  // aria-disabled keeps the button focusable (so its hint is discoverable) but inert.
  submit.addEventListener("click", (event) => {
    if (submit.getAttribute("aria-disabled") === "true" && !submitting) {
      event.preventDefault();
      const errors: FieldErrors = {};
      if (!joined.checked) errors.joinedDiscord = "Tick this box once you have joined the Hexenbane Discord server.";
      if (!agreed.checked) errors.agreementAccepted = "You must read and agree to the Private Playtest Agreement to apply.";
      showErrors(errors, new Set(["joinedDiscord", "agreementAccepted"] as FieldName[]));
      (!joined.checked ? joined : agreed).focus();
    }
  });

  function showSuccess(applicationId: string) {
    const idEl = success.querySelector<HTMLElement>("[data-success-id]")!;
    idEl.textContent = applicationId;
    form!.hidden = true;
    success.hidden = false;
    success.focus();
    success.scrollIntoView({ block: "start", behavior: "smooth" });
    const copy = success.querySelector<HTMLButtonElement>("[data-copy-id]");
    copy?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(applicationId);
        copy.textContent = "Copied";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(idEl);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        copy.textContent = "Selected";
      }
    });
  }

  updateCounters();
  updateGate();
}
