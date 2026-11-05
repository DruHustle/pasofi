export type HelpArticle = { id?: string; question: string; answer: string };

// Ship policy guidance with the policy version so older API help cannot override it.
// These answers require no account lookup and remain available when the API is down.
export const policyHelpArticles: readonly HelpArticle[] = [
  { id: 'bundle-start', question: 'When does my bundle start?', answer: 'Validity is activated after the first network-confirmed connection and runs from its recorded start. A delayed confirmation uses that recorded start, not the report arrival time. Buying or redeeming alone queues access. Start within 30 days of purchase, by the exact deadline on your receipt. Check your account for the recorded expiry; access ends when the time or data runs out.' },
  { id: 'no-renewal', question: 'Will my bundle renew automatically?', answer: 'Bundles are prepaid, with no subscription or automatic renewal. Each purchase has a fixed data allowance and validity period. There is no automatic charge for extra data.' },
  { id: 'cash-refund', question: 'How do I request a cash refund or report a connection problem?', answer: 'Keep the receipt reference and ask the selling agent or call +263 715 092 221. Unused, unactivated access can be reviewed for a full cash refund by a separate supervisor; a request is not automatic approval. Wrong charges, failed delivery, interruptions and disputed usage are investigated individually, including started or expired bundles. Approval is not proof that cash has been returned. Read Service terms for review and complaint routes. Never share your recovery key.' },
  { id: 'privacy-request', question: 'How do I request access, correction or deletion of my information?', answer: 'Call +263 715 092 221 and ask for a privacy review. Requests are handled manually after checking that they relate to your account, without asking you to reveal passwords or recovery keys. We explain what can be provided or changed and information that must be retained. Signing out or a session expiring does not delete purchase or accounting records. Read Privacy information for processing locations, retention and the POTRAZ complaint route.' },
  { id: 'operator', question: 'Who operates PasoFi and where can I read the policies?', answer: 'PasoFi is operated by Onesa, at 3964 98th Crescent Kuwadzana 5. Customer support and privacy requests use +263 715 092 221. Open Service terms, refunds & privacy in your account tools or help. Policies are available without signing in; they do not change which sales or network features are enabled.' },
];

export function withPolicyHelp(articles: readonly HelpArticle[] = []): HelpArticle[] {
  return [...articles.filter(article => !policyHelpArticles.some(policy => (article.id && article.id === policy.id) || article.question.trim().toLocaleLowerCase() === policy.question.toLocaleLowerCase())), ...policyHelpArticles];
}
