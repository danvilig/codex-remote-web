export function validateUserInputAnswers(request, result) {
  const answers = result?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("Answers are required");
  const questions = request.params?.questions || [];
  if (Object.keys(answers).some(id => !questions.some(question => question.id === id))) throw new Error("Unknown question");
  for (const question of questions) {
    const values = Object.hasOwn(answers, question.id) && answers[question.id]?.answers;
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "string" || !values[0].trim()) throw new Error("Answer every question");
    if (question.options?.length && !question.isOther && !question.options.some(option => option.label === values[0])) throw new Error("Choose one of the available options");
  }
  return result;
}

