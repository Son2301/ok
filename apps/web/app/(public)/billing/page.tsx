import { redirect } from 'next/navigation';

/** Short alias used in PR comments and emails ("top up at …/billing"). */
export default function BillingAlias() {
  redirect('/console/billing');
}
