// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * Boon — gratitude tipping in USDC with handle-keyed escrow + auto-push to linked wallets.
 *
 * USDC-only by design (v1). The contract pins one ERC-20 at construction.
 *
 * Canonical handle invariant:
 *   All clients MUST canonicalize via boon/normalize before computing handleHash.
 *   The contract enforces `keccak256(bytes(displayHandle)) == handleHash` and,
 *   in v1, only accepts `github:` and `x:` handles so direct contract calls
 *   cannot strand funds against unsupported OAuth providers.
 *
 * Escrow-link hardening:
 *   Normal `link()` can bind handles that have no pre-existing escrow. If a
 *   handle already has escrow, linking requires `linkEscrowed()` with both the
 *   OAuth trustedSigner voucher and a second escrowGuardian voucher. This keeps
 *   one leaked BOON_SIGNER_KEY from being enough to redirect pre-funded escrow.
 *
 * Recovery:
 *   `relink()` lets a handle owner with a fresh trustedSigner proof rotate the
 *   linked wallet for future tips. Existing claimed/pushed funds are not moved.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract Boon {
    // ── Limits ───────────────────────────────────────────────────────────
    uint256 public constant MAX_HANDLE_LEN = 64;
    uint256 public constant MAX_NOTE_LEN = 280;

    // ── Immutables ───────────────────────────────────────────────────────
    address public immutable USDC;

    // ── Storage ──────────────────────────────────────────────────────────
    address public owner;
    address public trustedSigner;
    address public escrowGuardian;

    mapping(bytes32 => address) public linkedWallet; // handleHash → wallet
    mapping(bytes32 => uint256) public escrow; // handleHash → USDC balance
    mapping(bytes32 => uint256) public linkNonce; // replay guard per handle

    // ── EIP-712 ──────────────────────────────────────────────────────────
    bytes32 public constant LINK_TYPEHASH = keccak256(
        "Link(bytes32 providerHash,bytes32 handleHash,address recipient,uint256 nonce,uint256 deadline)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ── Events ───────────────────────────────────────────────────────────
    event Tip(
        bytes32 indexed handleHash,
        address indexed from,
        uint256 amount,
        string displayHandle,
        string note
    );
    event Pushed(bytes32 indexed handleHash, address indexed to, uint256 amount);
    event Linked(bytes32 indexed handleHash, address indexed wallet, string canonicalHandle);
    event Relinked(
        bytes32 indexed handleHash,
        address indexed oldWallet,
        address indexed newWallet,
        string canonicalHandle
    );
    event Claimed(bytes32 indexed handleHash, address indexed to, uint256 amount);
    event SignerRotated(address indexed oldSigner, address indexed newSigner);
    event EscrowGuardianRotated(address indexed oldGuardian, address indexed newGuardian);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────────
    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidVoucher();
    error VoucherExpired();
    error AlreadyLinked();
    error NotLinked();
    error HandleHashMismatch();
    error HandleEmpty();
    error HandleTooLong();
    error UnsupportedHandle();
    error NoteTooLong();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _signer, address _usdc) {
        if (_signer == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        owner = msg.sender;
        trustedSigner = _signer;
        escrowGuardian = msg.sender;
        USDC = _usdc;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Boon")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ── Core: tip a handle ───────────────────────────────────────────────
    function tip(
        bytes32 handleHash,
        string calldata displayHandle,
        uint256 amount,
        string calldata note
    ) external {
        if (amount == 0) revert ZeroAmount();
        _validateHandle(handleHash, displayHandle);
        if (bytes(note).length > MAX_NOTE_LEN) revert NoteTooLong();

        if (!IERC20(USDC).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        emit Tip(handleHash, msg.sender, amount, displayHandle, note);

        address linked = linkedWallet[handleHash];
        if (linked != address(0)) {
            if (!IERC20(USDC).transfer(linked, amount)) revert TransferFailed();
            emit Pushed(handleHash, linked, amount);
        } else {
            escrow[handleHash] += amount;
        }
    }

    // ── Link handle ↔ wallet ─────────────────────────────────────────────
    /// @notice Bind an unlinked social handle with no existing escrow.
    ///         Pre-funded handles must use linkEscrowed() with a guardian voucher.
    function link(
        bytes32 handleHash,
        string calldata canonicalHandle,
        address recipient,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _link(handleHash, canonicalHandle, recipient, deadline, signature, false, bytes(""));
    }

    /// @notice Bind an unlinked social handle that already has escrow. Requires
    ///         both trustedSigner and escrowGuardian to sign the same Link digest.
    function linkEscrowed(
        bytes32 handleHash,
        string calldata canonicalHandle,
        address recipient,
        uint256 deadline,
        bytes calldata signature,
        bytes calldata guardianSignature
    ) external {
        _link(handleHash, canonicalHandle, recipient, deadline, signature, true, guardianSignature);
    }

    /// @notice Rotate a linked handle to a new wallet using a fresh trustedSigner proof.
    ///         This affects only future pushes/claims; already pushed funds do not move.
    function relink(
        bytes32 handleHash,
        string calldata canonicalHandle,
        address newRecipient,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (newRecipient == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert VoucherExpired();
        _validateHandle(handleHash, canonicalHandle);

        address oldRecipient = linkedWallet[handleHash];
        if (oldRecipient == address(0)) revert NotLinked();

        bytes32 digest = _linkDigest(canonicalHandle, handleHash, newRecipient, deadline);
        if (_recover(digest, signature) != trustedSigner) revert InvalidVoucher();

        linkedWallet[handleHash] = newRecipient;
        unchecked {
            linkNonce[handleHash]++;
        }
        emit Relinked(handleHash, oldRecipient, newRecipient, canonicalHandle);
    }

    function _link(
        bytes32 handleHash,
        string calldata canonicalHandle,
        address recipient,
        uint256 deadline,
        bytes calldata signature,
        bool guardianRequired,
        bytes memory guardianSignature
    ) internal {
        if (recipient == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert VoucherExpired();
        _validateHandle(handleHash, canonicalHandle);
        if (linkedWallet[handleHash] != address(0)) revert AlreadyLinked();

        // Existing escrow is value-at-risk. Refuse single-signer links and require
        // the explicit two-signature linkEscrowed path instead.
        if (escrow[handleHash] != 0 && !guardianRequired) revert InvalidVoucher();

        bytes32 digest = _linkDigest(canonicalHandle, handleHash, recipient, deadline);
        if (_recover(digest, signature) != trustedSigner) revert InvalidVoucher();
        if (guardianRequired && _recover(digest, guardianSignature) != escrowGuardian) {
            revert InvalidVoucher();
        }

        linkedWallet[handleHash] = recipient;
        unchecked {
            linkNonce[handleHash]++;
        }
        emit Linked(handleHash, recipient, canonicalHandle);
    }

    // ── Claim accumulated escrow ─────────────────────────────────────────
    function claim(bytes32 handleHash) external {
        address recipient = linkedWallet[handleHash];
        if (recipient == address(0)) revert NotLinked();

        uint256 bal = escrow[handleHash];
        if (bal == 0) return;

        escrow[handleHash] = 0;
        if (!IERC20(USDC).transfer(recipient, bal)) revert TransferFailed();
        emit Claimed(handleHash, recipient, bal);
    }

    // ── Admin ────────────────────────────────────────────────────────────
    function rotateSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit SignerRotated(trustedSigner, newSigner);
        trustedSigner = newSigner;
    }

    function rotateEscrowGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit EscrowGuardianRotated(escrowGuardian, newGuardian);
        escrowGuardian = newGuardian;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    function _validateHandle(bytes32 handleHash, string calldata displayHandle) internal pure {
        uint256 len = bytes(displayHandle).length;
        if (len == 0) revert HandleEmpty();
        if (len > MAX_HANDLE_LEN) revert HandleTooLong();
        if (!_isSupportedHandle(displayHandle)) revert UnsupportedHandle();
        if (keccak256(bytes(displayHandle)) != handleHash) revert HandleHashMismatch();
    }

    function _linkDigest(
        string calldata canonicalHandle,
        bytes32 handleHash,
        address recipient,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 providerHash = _providerHashForHandle(canonicalHandle);
        bytes32 structHash = keccak256(
            abi.encode(
                LINK_TYPEHASH, providerHash, handleHash, recipient, linkNonce[handleHash], deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _isSupportedHandle(string calldata canonicalHandle) internal pure returns (bool) {
        bytes calldata b = bytes(canonicalHandle);
        if (b.length >= 3 && b[0] == "x" && b[1] == ":") return true;
        return (b.length >= 8 && b[0] == "g" && b[1] == "i" && b[2] == "t" && b[3] == "h"
                && b[4] == "u" && b[5] == "b" && b[6] == ":");
    }

    function _providerHashForHandle(string calldata canonicalHandle)
        internal
        pure
        returns (bytes32)
    {
        bytes memory handleBytes = bytes(canonicalHandle);
        uint256 providerLength = handleBytes.length;
        for (uint256 i; i < handleBytes.length;) {
            if (handleBytes[i] == ":") {
                providerLength = i;
                break;
            }
            unchecked {
                ++i;
            }
        }

        bytes memory provider = new bytes(providerLength);
        for (uint256 i; i < providerLength;) {
            provider[i] = handleBytes[i];
            unchecked {
                ++i;
            }
        }
        return keccak256(provider);
    }

    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
