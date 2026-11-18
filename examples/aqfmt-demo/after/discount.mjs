export function discountedTicketPrice(ticket, customer) {
  const originalPrice = ticket.price;
  let discount = 0;

  const isEligibleForGroupDiscount =
    customer.isMember &&
    ticket.isWeekday &&
    ticket.quantity >= 4 &&
    originalPrice >= 10000;

  if (isEligibleForGroupDiscount) {
    discount = Math.floor(originalPrice * 0.2);
  }

  return originalPrice - discount;
}
