// Human scorecard for Stage 5: open the preview (node src/cli.js preview --project <id>) and score each question 1-5.
// The measurable checks (image areas, exact copy, colors, invented text) are in: node src/cli.js design-metrics --project <id>

export const questions = [
  'Does it look professional and crafted, not AI-generic?',
  'Does it follow the business personality and brand (colors, feeling)?',
  'Did it avoid adding things we did not ask for (extra sections, banners, invented items)?',
  'Do the variants offer real choices?',
  'Does it look clearly different from the other businesses?',
];
