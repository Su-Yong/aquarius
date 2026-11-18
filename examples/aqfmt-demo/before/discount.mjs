export function discountedTicketPrice(ticket, customer) {
  const originalPrice = ticket.price;
  let discount = 0;

  if (
    customer.isMember &&
    ticket.isWeekday &&
    ticket.quantity >= 4 &&
    originalPrice >= 10000
  ) {
    discount = Math.floor(originalPrice * 0.2);
  }

  return originalPrice - discount;
}
