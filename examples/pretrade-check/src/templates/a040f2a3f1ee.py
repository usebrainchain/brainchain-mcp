_MANDATE = r"""
{mandate}
"""

import base64 as _base64
import hashlib as _hashlib
import json as _json
import re as _re
from datetime import datetime as _datetime, timezone as _timezone

_ALLOWANCE_HOLDER = "0x0000000000001ff3684f28c67538d4d072c22734"
# exec(address operator, address token, uint256 amount, address target, bytes data) on AllowanceHolder
_EXEC = "2213bc0b"
# execute((address recipient, address buyToken, uint256 minAmountOut), bytes[] actions, bytes32 zid) on Settler
_EXECUTE = "1fff991f"
_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
_ZERO = "0x0000000000000000000000000000000000000000"
_KEY_ID = "0x-signing-key-prod-24092026"
_KEY_X = "19P3C981JsyQsqwVho8Tlabx51rslvdruSH59mGuWn0"
_COVERED = ['"@status"', '"content-type"', '"content-digest"', '"@method";req', '"@authority";req', '"@path";req', '"@query";req']
_SIGNED_REQUEST = {"method": "GET", "authority": "api.0x.org", "path": "/swap/allowance-holder/quote"}
_FRESH_SECONDS = 60
# The only parameters this client sends, slippageBps being optional. 0x reads others, fee and surplus recipients among
# them, so any other is refused.
_QUERY = ("chainId", "sellToken", "buyToken", "sellAmount", "taker")
_QUERY_OPTIONAL = ("slippageBps",)
_FEE_PARAMS = ("swapFeeRecipient", "swapFeeBps", "swapFeeToken", "tradeSurplusRecipient", "tradeSurplusMaxBps")

# Ed25519 verification as RFC 8032 section 5.1.7 gives it, on Python integers: the sandbox has hashlib but no curve.
_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _recover_x(y, sign):
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P:
        x = x * _SQRT_M1 % _P
    if (x * x - x2) % _P:
        return None
    return _P - x if (x & 1) != sign else x


def _point(encoded):
    y = int.from_bytes(encoded, "little")
    sign, y = y >> 255, y & ((1 << 255) - 1)
    x = _recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % _P)


def _add(p, q):
    A, B = (p[1] - p[0]) * (q[1] - q[0]) % _P, (p[1] + p[0]) * (q[1] + q[0]) % _P
    C, D = 2 * p[3] * q[3] * _D % _P, 2 * p[2] * q[2] % _P
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _P, G * H % _P, F * G % _P, E * H % _P)


def _times(n, p):
    q = (0, 1, 1, 0)
    while n:
        if n & 1:
            q = _add(q, p)
        p = _add(p, p)
        n >>= 1
    return q


_GY = 4 * pow(5, _P - 2, _P) % _P
_GX = _recover_x(_GY, 0)
_G = (_GX, _GY, 1, _GX * _GY % _P)


def _ed25519(public, message, signature):
    if len(public) != 32 or len(signature) != 64:
        return False
    a, r = _point(public), _point(signature[:32])
    s = int.from_bytes(signature[32:], "little")
    if a is None or r is None or s >= _L:
        return False
    k = int.from_bytes(_hashlib.sha512(signature[:32] + public + message).digest(), "little") % _L
    left, right = _times(s, _G), _add(r, _times(k, a))
    return (left[0] * right[2] - right[0] * left[2]) % _P == 0 and (left[1] * right[2] - right[1] * left[2]) % _P == 0


# RFC 8032 test 1: a verifier that cannot pass it says nothing about 0x's signature.
if not _ed25519(
    bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
    b"",
    bytes.fromhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
):
    raise AssertionError("the Ed25519 verifier fails RFC 8032's first test vector")


def _b64url(text):
    return _base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _signature(delivery):
    """Whether 0x's key signed this response to this request, and the time the signature claims."""
    request, response = delivery["request"], delivery["response"]
    found = _re.fullmatch(r'sig=\(([^)]*)\)((?:;[a-z]+=(?:"[^"]*"|\d+))*)', response["signature-input"])
    if not found:
        return False, "the Signature-Input header is not one signature labelled sig", None
    components = found.group(1).split(" ")
    params = {k: (q if q else int(n)) for k, q, n in _re.findall(r';([a-z]+)=(?:"([^"]*)"|(\d+))', found.group(2))}
    # Read before it is verified, so the time rules judge it on their own; the signature rule says whether 0x made it.
    created = params.get("created") if isinstance(params.get("created"), int) else None
    if components != _COVERED:
        return False, "the signature covers " + " ".join(components) + ", not the status, body digest and whole request", created
    if params.get("keyid") != _KEY_ID or params.get("tag") != "0x-swap-api" or created is None:
        return False, "the signature is not made with 0x's key " + _KEY_ID + " and tag 0x-swap-api", created
    for name, value in _SIGNED_REQUEST.items():
        if request[name] != value:
            return False, "the request is " + request["method"] + " " + request["authority"] + request["path"] + ", not 0x's quote endpoint", created
    if response["status"] != 200:
        return False, "0x answered " + str(response["status"]) + ", not a quote", created
    digest = "sha-256=:" + _base64.b64encode(_hashlib.sha256(response["body"].encode("utf-8")).digest()).decode() + ":"
    if digest not in [d.strip() for d in response["content-digest"].split(",")]:
        return False, "the body's SHA-256 does not match its Content-Digest, so the body is not the one 0x sent", created
    values = [str(response["status"]), response["content-type"], response["content-digest"], request["method"], request["authority"], request["path"], request["query"]]
    base = "\n".join(c + ": " + v for c, v in zip(_COVERED, values)) + '\n"@signature-params": ' + response["signature-input"][len("sig="):]
    signed = _re.fullmatch(r"sig=:([A-Za-z0-9+/]+={0,2}):", response["signature"])
    if not signed or len(signed.group(1)) % 4 or not _ed25519(_b64url(_KEY_X), base.encode("utf-8"), _base64.b64decode(signed.group(1))):
        return False, "0x's Ed25519 signature does not verify over this response and request", created
    return True, "0x signed this response with " + _KEY_ID + " at " + _iso(created) + ", over its body and the request GET api.0x.org" + request["path"], created


def _iso(seconds):
    return _datetime.fromtimestamp(seconds, _timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _address(word):
    if any(word[:12]):
        raise ValueError("an address word has bits set above 160")
    return "0x" + word[12:].hex()


def _call(data):
    """AllowanceHolder.exec and the Settler.execute call inside it, read by the ABI's own layout."""
    if data[:4].hex() != _EXEC or len(data) < 4 + 32 * 6:
        raise ValueError("the transaction does not call exec on AllowanceHolder")
    word = lambda i: data[4 + 32 * i : 36 + 32 * i]
    start = 4 + int.from_bytes(word(4), "big")
    length = int.from_bytes(data[start : start + 32], "big")
    inner = data[start + 32 : start + 32 + length]
    if len(inner) != length or any(data[start + 32 + length :]):
        raise ValueError("the Settler call inside exec is cut short or followed by other data")
    if inner[:4].hex() != _EXECUTE or len(inner) < 4 + 32 * 3:
        raise ValueError("the call inside exec is not Settler's execute")
    slot = lambda i: inner[4 + 32 * i : 36 + 32 * i]
    return {
        "operator": _address(word(0)),
        "token": _address(word(1)),
        "amount": int.from_bytes(word(2), "big"),
        "target": _address(word(3)),
        "recipient": _address(slot(0)),
        "buyToken": _address(slot(1)),
        "minOut": int.from_bytes(slot(2), "big"),
    }


def _base_units(amount, decimals):
    whole, _, fraction = amount.partition(".")
    if len(fraction) > decimals:
        raise ValueError(amount + " has more decimals than the token's " + str(decimals))
    return int(whole + fraction.ljust(decimals, "0"))


def _shown(units, token):
    if token is None:
        return str(units) + " base units"
    whole, fraction = divmod(units, 10 ** token["decimals"])
    digits = str(fraction).rjust(token["decimals"], "0").rstrip("0")
    return str(whole) + ("." + digits if digits else "") + " " + token["symbol"]


_SHAPE = {
    "request": {"method": str, "authority": str, "path": str, "query": str},
    "response": {"status": int, "content-type": str, "content-digest": str, "signature-input": str, "signature": str, "body": str},
    "receivedAt": int,
    "registry": {"block": int, "settler": str, "previous": str},
}


def _misshapen(value, shape, at="DELIVERY"):
    if not isinstance(shape, dict):
        return None if type(value) is shape else at + " is not " + shape.__name__
    if type(value) is not dict:
        return at + " is not an object"
    extra = sorted(set(value) - set(shape))
    if extra:
        return at + " has " + ", ".join(repr(k) for k in extra) + ", which the checks do not read"
    for key, inner in shape.items():
        problem = _misshapen(value[key], inner, at + "[" + repr(key) + "]") if key in value else at + " has no " + repr(key)
        if problem:
            return problem
    return None


def _unique(pairs):
    found = {}
    for key, value in pairs:
        if key in found:
            raise ValueError(repr(key) + " appears twice")
        found[key] = value
    return found


def _not_json(name):
    raise ValueError(name + " is not JSON")


def _delivery(value):
    """The delivery read from DELIVERY's string alone, with this module's own base64 and json."""
    if type(value) is not str:
        raise ValueError("DELIVERY is " + ("missing" if value is None else "a " + type(value).__name__) + ", not a string")
    try:
        text = _base64.b64decode(value, validate=True).decode("utf-8")
        delivery = _json.loads(text, object_pairs_hook=_unique, parse_constant=_not_json)
    except ValueError as error:
        raise ValueError("DELIVERY is not base64 of JSON: " + str(error)) from None
    problem = _misshapen(delivery, _SHAPE)
    if problem:
        raise ValueError(problem)
    return delivery, len(value)


def _query(text):
    """
    The request's query, read strictly: the names this client sends, each once, with values of letters and digits.
    Nothing is percent-decoded, so 0x reads every value exactly as written here.
    """
    if not text.startswith("?"):
        return {}, [], ["it does not start with ?"]
    values, names, problems = {}, [], []
    for part in text[1:].split("&"):
        name, sep, value = part.partition("=")
        names.append(name)
        if not sep or not _re.fullmatch(r"[A-Za-z]+", name) or not _re.fullmatch(r"[A-Za-z0-9]+", value):
            problems.append("'" + part + "' is not a name=value pair of letters and digits")
        elif name not in _QUERY + _QUERY_OPTIONAL:
            problems.append("it asks for " + name + ", which the checks do not allow")
        elif name in values:
            problems.append("it names " + name + " twice")
        else:
            values[name] = value
    problems += ["it has no " + name for name in _QUERY if name not in values]
    return values, names, problems


def _run(given, mandate):
    try:
        delivery, length = _delivery(given)
    except ValueError as error:
        print("FAIL  delivery: " + str(error))
        raise AssertionError("the delivery cannot be read: " + str(error)) from None
    outcomes = []

    def rule(name, ok, why):
        outcomes.append((name, ok))
        print(("pass  " if ok else "FAIL  ") + name + ": " + why)

    tokens = {t["address"].lower(): t for t in mandate["tokens"]}
    wallet, recipient = mandate["wallet"].lower(), mandate["recipient"].lower()
    request, response = delivery["request"], delivery["response"]
    query, asked, malformed = _query(request["query"])
    try:
        quote = _json.loads(response["body"])
    except ValueError:
        quote = None
    quote = quote if type(quote) is dict else {}
    tx = quote.get("transaction") if type(quote.get("transaction")) is dict else {}
    data = tx.get("data") if type(tx.get("data")) is str else ""
    try:
        call = _call(bytes.fromhex(data[2:]) if data.startswith("0x") else b"")
    except ValueError as error:
        call, unread = None, str(error)
    quoted = int(quote["buyAmount"]) if type(quote.get("buyAmount")) is str and _re.fullmatch(r"[0-9]+", quote["buyAmount"]) else 0
    native = call is not None and call["token"] == _ZERO
    sell = _NATIVE if native else (call or {}).get("token")
    buy = (call or {}).get("buyToken")

    if call:
        print(
            "Trade: sell " + _shown(call["amount"], tokens.get(sell)) + " for at least " + _shown(call["minOut"], tokens.get(buy))
            + (" (0x quoted " + _shown(quoted, tokens.get(buy)) + ")" if quoted else "")
            + ", paid to " + call["recipient"] + ", on chain " + query.get("chainId", "?") + ", quoted at block " + str(quote.get("blockNumber", "?"))
        )
    else:
        print("Trade: the transaction could not be read: " + unread)

    rule("delivery", True, "DELIVERY is a string of " + str(length) + " base64 characters, JSON with exactly the fields these checks read")

    ok, why, created = _signature(delivery)
    rule("signature", ok, why)

    if created is None:
        rule("fresh", False, "the signature names no time to compare with")
    else:
        age = delivery["receivedAt"] - created
        rule("fresh", -5 <= age <= _FRESH_SECONDS, "the agent received the quote " + str(age) + (" second" if age == 1 else " seconds") + " after the time its signature names, by the agent's clock; 0x allows " + str(_FRESH_SECONDS))

    rule("query", not malformed, "; ".join(malformed) or "the request asks 0x for " + ", ".join(n for n in _QUERY + _QUERY_OPTIONAL if n in query) + ", each once, and nothing else")

    chain = query.get("chainId")
    rule("chain", chain == str(mandate["chain"]), "the quote is for chain " + str(chain) + ("" if chain == str(mandate["chain"]) else ", the mandate allows " + str(mandate["chain"])))

    taker = query.get("taker", "").lower()
    rule("wallet", taker == wallet, "the quote is for wallet " + (taker or "(none)") + ("" if taker == wallet else ", not the mandate's " + wallet))

    if call is None:
        for name in ("contract", "tokens", "size", "minimum out", "recipient"):
            rule(name, False, "the transaction could not be read: " + unread)
    else:
        registry = delivery["registry"]
        # A chain with one Settler has no previous one; the registry read gives it as the zero address, which never counts.
        settlers = {a.lower() for a in (registry["settler"], registry["previous"])} - {_ZERO}
        to = str(tx.get("to", "")).lower()
        problems = []
        if to != _ALLOWANCE_HOLDER:
            problems.append("it calls " + to + ", not AllowanceHolder " + _ALLOWANCE_HOLDER)
        if call["operator"] != call["target"] or call["target"] not in settlers:
            problems.append("it hands the sell token to " + call["target"] + ", which is not the Settler 0x's registry named")
        if str(registry["block"]) != quote.get("blockNumber"):
            problems.append("the registry was read at block " + str(registry["block"]) + ", not at the quote's block " + str(quote.get("blockNumber")))
        rule("contract", not problems, "; ".join(problems) or "it calls AllowanceHolder, which lets Settler " + call["target"] + " take the sell amount for this one call; 0x's registry named that Settler at the quote's block")

        outside = [a for a in (sell, buy) if a not in tokens]
        side = lambda a: tokens[a]["symbol"] if a in tokens else str(a) + ", which the mandate does not list"
        rule("tokens", not outside, "sells " + side(sell) + "; buys " + side(buy))

        problems = []
        cap = _base_units(tokens[sell]["maxSell"], tokens[sell]["decimals"]) if sell in tokens else None
        if cap is None:
            problems.append("the mandate sets no limit for this token")
        elif call["amount"] > cap:
            problems.append("over the token's maxSell of " + _shown(cap, tokens[sell]))
        if str(call["amount"]) != query.get("sellAmount") or str(call["amount"]) != quote.get("sellAmount"):
            problems.append("the transaction sells a different amount from the one asked for")
        if str(tx.get("value", "0")) != str(call["amount"] if native else 0):
            problems.append("the transaction sends " + str(tx.get("value")) + " wei of ETH with it")
        if sell != str(quote.get("sellToken") or "").lower() or buy != str(quote.get("buyToken") or "").lower():
            problems.append("the transaction trades other tokens than the quote names")
        rule("size", not problems, "sells " + _shown(call["amount"], tokens.get(sell)) + ("; " + "; ".join(problems) if problems else ", within the token's maxSell of " + _shown(cap, tokens[sell])))

        floor = -(-quoted * (10_000 - mandate["maxSlippageBps"]) // 10_000)
        slip = (quoted - call["minOut"]) * 10_000 / quoted if quoted else 0
        problems = []
        if call["minOut"] < floor:
            problems.append("that is " + format(slip, ".1f") + " bps under 0x's quote, over the mandate's " + str(mandate["maxSlippageBps"]))
        if str(call["minOut"]) != quote.get("minBuyAmount"):
            problems.append("the transaction's minimum differs from the quote's minBuyAmount")
        rule("minimum out", quoted > 0 and not problems, "the trade reverts unless it pays at least " + _shown(call["minOut"], tokens.get(buy))
             + ("; " + "; ".join(problems) if problems else ", " + format(slip, ".1f") + " bps under 0x's quote, within the mandate's " + str(mandate["maxSlippageBps"])))

        rule("recipient", call["recipient"] == recipient, "pays " + call["recipient"] + ("" if call["recipient"] == recipient else ", not the mandate's recipient " + recipient))

    # The request can name no fee or surplus recipient, and the minimum out is the recipient's whatever 0x keeps as its own fee.
    fees = quote.get("fees") if type(quote.get("fees")) is dict else {}
    added = [p for p in _FEE_PARAMS if p in asked] + (["an integrator fee in the quote"] if fees.get("integratorFee") or fees.get("integratorFees") else [])
    rule("fees", not added, "no fee but 0x's own" if not added else "the quote adds " + ", ".join(added))

    until = _datetime.fromisoformat(mandate["validUntil"].replace("Z", "+00:00")).timestamp()
    rule("deadline", created is not None and created <= until, ("the signature is dated " + _iso(created) if created is not None else "the signature names no time") + ", and the mandate runs until " + mandate["validUntil"])

    failed = [name for name, ok in outcomes if not ok]
    print(str(len(outcomes) - len(failed)) + " of " + str(len(outcomes)) + " rules pass" + ("." if not failed else "; failed: " + ", ".join(failed) + "."))
    if failed:
        raise AssertionError("the trade breaks the mandate: " + ", ".join(failed))


_run(globals().get("DELIVERY"), _json.loads(_MANDATE))