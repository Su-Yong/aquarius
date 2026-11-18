function summarizeTickets(tickets) {
  let totalQuantity = 0;
  let totalPrice = 0;

  for (const ticket of tickets) {
    totalQuantity += ticket.quantity;
    totalPrice += ticket.price * ticket.quantity;
  }

  return { totalQuantity, totalPrice };
}

export function ticketReceipt(tickets) {
  const { totalQuantity, totalPrice } = summarizeTickets(tickets);
  const lines = ["영화 예매 영수증"];

  for (const ticket of tickets) {
    const subtotal = ticket.price * ticket.quantity;
    lines.push(`${ticket.title}: ${ticket.quantity}장 / ${subtotal}원`);
  }

  lines.push(`총 수량: ${totalQuantity}장`);
  lines.push(`결제 금액: ${totalPrice}원`);

  return lines.join("\n");
}
