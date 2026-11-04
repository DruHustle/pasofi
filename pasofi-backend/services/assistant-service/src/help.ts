export type HelpArticle = {
  id: string;
  category: 'bundles' | 'payments' | 'account' | 'connection';
  question: string;
  answer: string;
};

// Reviewed product guidance only. No account lookup, generated claims or actions.
export const articles: readonly HelpArticle[] = [
  { id: 'preview', category: 'connection', question: 'Can I buy Wi-Fi or connect right now?', answer: 'Check the app for current bundle, purchase and connection availability. Unavailable options cannot be completed. Preview or example bundles are not live offers.' },
  { id: 'bundle-start', category: 'bundles', question: 'When does my bundle start?', answer: 'The intended service starts your time only after a verified successful connection. Buying or redeeming a bundle queues it; that alone does not start its validity. Access ends when the time or data runs out.' },
  { id: 'data-usage', category: 'bundles', question: 'What counts towards my data?', answer: 'Both uploads and downloads count. One GB is 1,000,000,000 bytes. Video, app updates and cloud backups can use data quickly.' },
  { id: 'two-sites', category: 'connection', question: 'Can I use my bundle at another site?', answer: 'Check the available sites and the terms for your bundle. Only one connection per customer can be active at a time. A new connection must wait until the previous connection is confirmed closed.' },
  { id: 'pending-payment', category: 'payments', question: 'What if my payment is pending?', answer: 'Check the existing order before trying again. A delayed response does not prove that a payment failed. Keep your order reference and do not pay a second time just to refresh the status. Payment confirmation does not itself mean you are connected.' },
  { id: 'top-ups', category: 'bundles', question: 'How do top-ups work?', answer: 'Top-ups wait in purchase order; they do not reset the current bundle or combine its allowance. Each purchase has its own start-by deadline. Check the displayed terms for each purchase.' },
  { id: 'no-renewal', category: 'payments', question: 'Will my bundle renew automatically?', answer: 'The planned bundles are prepaid, with no subscription or automatic renewal. Each purchase has a fixed data allowance and validity period.' },
  { id: 'voucher', category: 'payments', question: 'How will buying a voucher from an agent work?', answer: 'Where agent sales are available, an authorized sale provides one private voucher. Private receipt and SMS delivery can refer to the same voucher, not two bundles. Keep it private and check the app for available delivery methods.' },
  { id: 'recovery', category: 'account', question: 'How do I recover my account on another device?', answer: 'Before leaving your current browser, open Recover and save both your account reference and recovery key somewhere private. Enter both on the other device to restore your account. Keep the key out of chat and screenshots you share. PamoFi help cannot retrieve a lost recovery key.' },
  { id: 'recovery-rotation', category: 'account', question: 'What happens when I replace my recovery key?', answer: 'Only the newest recovery key works. Save the replacement immediately. If the response is interrupted, the old key may already have been replaced; use your current signed-in browser to check the recovery version and create a fresh key.' },
  { id: 'sign-out', category: 'account', question: 'How do I leave a shared browser safely?', answer: 'Save your recovery details first, then use Sign out. This ends the current browser session. Signing out of the portal is not a request to end an already established hotspot connection; network access is managed separately.' },
  { id: 'help-scope', category: 'account', question: 'What can PamoFi help do?', answer: 'Help explains reviewed product guidance. It cannot take payments, activate vouchers, change allowances or control routers. Do not enter payment details, voucher codes, recovery keys or passwords in help search. Use your account tools to check your own purchases and balance.' }
];

export function findHelp(query = ''): HelpArticle[] {
  const words = query.normalize('NFKC').toLocaleLowerCase('en').trim().split(/\s+/u).filter(Boolean);
  return articles.filter(article => {
    const text = `${article.question} ${article.answer}`.normalize('NFKC').toLocaleLowerCase('en');
    return words.every(word => text.includes(word));
  });
}
