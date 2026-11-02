import { validateUserInputAnswers } from '../src/shared/user-input.js';
export { validateUserInputAnswers };

export function createUserInputCard(request, { document = globalThis.document, onSubmit, translate = text => text } = {}) {
  const card = document.createElement("section");
  card.className = "approval-card user-input-card";
  card.dataset.userInputRequest = String(request.id);
  const form = document.createElement("form");
  const title = document.createElement("h3");
  title.textContent = translate("Your input is needed");
  form.append(title);
  const readers = [];
  for (const [index, question] of (request.params?.questions || []).entries()) {
    const field = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = question.header || question.question;
    const prompt = document.createElement("p");
    prompt.textContent = question.question;
    field.append(legend, prompt);
    const input = document.createElement(question.isSecret ? "input" : "textarea");
    if (question.isSecret) { input.type = "password"; input.autocomplete = "off"; }
    input.setAttribute("aria-label", question.question);
    input.rows = 3;
    let selected = null;
    if (question.options?.length) {
      for (const [optionIndex, option] of question.options.entries()) {
        const label = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio"; radio.name = `question-${index}`; radio.value = String(optionIndex); radio.required = true;
        const copy = document.createElement("span");
        const name = document.createElement("strong"); name.textContent = option.label;
        const description = document.createElement("small"); description.textContent = option.description || "";
        copy.append(name, description); label.append(radio, copy); field.append(label);
        radio.addEventListener("change", () => { selected = option.label; input.disabled = true; input.required = false; });
      }
      if (question.isOther) {
        const label = document.createElement("label"), radio = document.createElement("input"), copy = document.createElement("span");
        radio.type = "radio"; radio.name = `question-${index}`; radio.required = true; radio.value = "other";
        copy.textContent = translate("Other"); label.append(radio, copy); field.append(label);
        input.disabled = true;
        radio.addEventListener("change", () => { selected = null; input.disabled = false; input.required = true; input.focus(); });
        field.append(input);
      }
    } else { input.required = true; field.append(input); }
    readers.push(() => [question.id, { answers: [selected ?? input.value] }]);
    form.append(field);
  }
  const error = document.createElement("p"); error.className = "user-input-error"; error.role = "alert"; error.hidden = true;
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "approval-primary"; submit.textContent = translate("Send answers");
  form.append(error, submit); card.append(form);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (form.dataset.sending === "true") return;
    const controls = [...form.elements].map(element => [element, element.disabled]);
    try {
      const result = validateUserInputAnswers(request, { answers: Object.fromEntries(readers.map(read => read())) });
      form.dataset.sending = "true"; error.hidden = true;
      for (const [element] of controls) element.disabled = true;
      await onSubmit(result);
    } catch (reason) { error.textContent = reason.message || translate("Could not send answers"); error.hidden = false; }
    finally {
      form.dataset.sending = "false";
      for (const [element, disabled] of controls) element.disabled = disabled;
    }
  });
  return card;
}
