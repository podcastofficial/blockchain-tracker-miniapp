export function send(res, status, body) {
  res.status(status).json(body);
}
export function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  return send(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
}
export function getBearer(req) {
  const value = req.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}
