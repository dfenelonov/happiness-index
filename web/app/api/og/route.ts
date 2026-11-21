import { appConfig } from "@/lib/config";
import { ogCard } from "@/lib/images";

export async function GET() {
  const app = appConfig();
  return ogCard({ title: app.landing.headline, subtitle: `${app.landing.subheadline}. Бесплатно.` });
}
