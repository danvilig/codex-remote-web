import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createUserInputCard, validateUserInputAnswers } from "../../public/user-input.js";

describe("interactive user input", () => {
  test("rejects missing, unknown and forged answers while allowing explicit free text", () => {
    const request = { id: 1, params: { questions: [{ id: "choice", options: [{ label: "A" }], isOther: false }] } };
    expect(() => validateUserInputAnswers(request, {})).toThrow();
    expect(() => validateUserInputAnswers(request, { answers: { choice: { answers: ["B"] } } })).toThrow();
    expect(() => validateUserInputAnswers(request, { answers: { choice: { answers: ["A"] }, extra: { answers: ["B"] } } })).toThrow();
    request.params.questions[0].isOther = true;
    expect(validateUserInputAnswers(request, { answers: { choice: { answers: ["Custom"] } } })).toBeDefined();
  });

  test("renders untrusted question text safely and sends selected answers", async () => {
    const dom = new JSDOM("<body></body>"), document = dom.window.document;
    const replies: unknown[] = [];
    const request = { id: 1, params: { questions: [{ id: "q", header: "<img src=x>", question: "Choose", options: [{ label: "A", description: "First" }], isOther: false }] } };
    const card = createUserInputCard(request, { document, onSubmit: async result => replies.push(result) });
    document.body.append(card);
    expect(card.querySelector("img")).toBeNull();
    const radio = card.querySelector("input")! as HTMLInputElement; radio.checked = true; radio.dispatchEvent(new dom.window.Event("change"));
    card.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await Promise.resolve();
    expect(replies).toEqual([{ answers: { q: { answers: ["A"] } } }]);
    dom.window.close();
  });

  test("keeps failed submissions editable and masks secret input", async () => {
    const dom = new JSDOM("<body></body>"), document = dom.window.document;
    const card = createUserInputCard({ id: 2, params: { questions: [{ id: "secret", question: "Token", isSecret: true }] } }, { document, onSubmit: async () => { throw new Error("Connection interrupted"); } });
    document.body.append(card);
    const input = card.querySelector("input")!;
    expect(input.type).toBe("password"); input.value = "dummy";
    card.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await Promise.resolve(); await Promise.resolve();
    expect(card.querySelector("[role=alert]")!.textContent).toBe("Connection interrupted");
    expect(input.disabled).toBe(false); expect(input.value).toBe("dummy");
    dom.window.close();
  });
});
