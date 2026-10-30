// The fixed core interview questions for Stage 1. The key is the field name in inputs/answers.json.
// type: "text" (required), "optional" (may be skipped), or a special type handled in interview.js.

export const CORE_QUESTIONS = [
  { key: 'businessName', type: 'text', message: '1. What is the name of your business?' },
  { key: 'whatItDoes', type: 'text', message: '2. What does your business do?' },
  { key: 'locationAndContact', type: 'contact', message: '3. Location and contact details' },
  { key: 'customers', type: 'text', message: '4. Who is your ideal customer? Who is your business for?' },
  { key: 'notFor', type: 'optional', message: '4b. Who is your business NOT for? (optional, this helps attract the right people)' },
  { key: 'story', type: 'optional', message: '4c. Tell us your story: how did it start, what makes you special? (optional, we will write it in better words)' },
  { key: 'mainGoal', type: 'text', message: '5. What is the #1 thing the website must achieve? Anything else?' },
  { key: 'productsAndServices', type: 'text', message: '6. Main products/services (name, short description, price only if you want it shown). Separate them with ;' },
  { key: 'pages', type: 'pages', message: '7. Which pages do you want? (edit the suggestion, separate with commas)' },
  { key: 'features', type: 'features', message: '8. Which features do you want?' },
  { key: 'brand', type: 'optional', message: '9. Do you have brand colors, fonts or a logo? Describe them.' },
  { key: 'brandFeeling', type: 'text', message: '10. Describe the feeling of your brand in 3 words:' },
  { key: 'likedSites', type: 'optional', message: '11. Websites you like and why (optional):' },
  { key: 'dislikedSites', type: 'optional', message: '12. Websites you dislike and why (optional):' },
  { key: 'homeWishes', type: 'optional', message: '13b. Is there anything you would love to see on your home page, or a picture you imagine? (optional)' },
  { key: 'anythingElse', type: 'optional', message: '13. Anything else we should know? (optional)' },
];

export const FEATURE_CHOICES = [
  { name: 'Contact form', value: 'contact form' },
  { name: 'Map', value: 'map' },
  { name: 'Booking link', value: 'booking link' },
  { name: 'Social links', value: 'social links' },
  { name: 'Gallery', value: 'gallery' },
];
