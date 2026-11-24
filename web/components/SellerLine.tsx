import { sellerLine } from "@/lib/seller";

/** Реквизиты продавца в футере: ЮKassa проверяет ФИО и ИНН на сайте. Без SELLER_* ничего не выводит. */
export function SellerLine() {
  const line = sellerLine();
  return line ? <p data-testid="seller">{line}</p> : null;
}
