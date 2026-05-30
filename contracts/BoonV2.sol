// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20V2 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IERC20PermitV2 {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface IIdentityRegistryV2 {
    function getAgentWallet(uint256 agentId) external view returns (address);
    function ownerOf(uint256 agentId) external view returns (address);
}

interface IBoonGratitudeAttestation {
    function mint(
        uint256 tipId,
        address recipient,
        bytes32 handleHashAtMint,
        uint256 agentIdAtMint,
        bytes32 privateCommitment,
        uint256 boonBurnedTotal
    ) external;
}

contract BoonV2 {
    struct Permit {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct AgentResolution {
        address owner;
        address agentWallet;
        address payoutWallet;
    }

    // ── Limits ───────────────────────────────────────────────────────────
    uint256 public constant MAX_HANDLE_LEN = 90;
    uint256 public constant MAX_NOTE_LEN = 280;
    address public constant BOON_BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ── Immutables ───────────────────────────────────────────────────────
    address public immutable USDC;
    address public immutable boonToken;
    address public immutable identityRegistry;
    address public immutable attestationContract;
    uint256 public immutable PRIVATE_TIP_BURN;
    uint256 public immutable ATTESTATION_BURN;
    uint256 public immutable UNLOCK_PRICE_USDC;

    // ── Admin / v2 link state ────────────────────────────────────────────
    // v0 admin trust model:
    // - owner can only rotate owner/trustedSigner. It cannot pause tips,
    //   sweep funds, change burn/unlock immutables, or rewrite links.
    // - trustedSigner signs OAuth/social-link vouchers for link and relink.
    //   It cannot move funds without a user-submitted call.
    // Production deployments should transfer owner to a Safe/multisig or
    // timelock and keep trustedSigner on a distinct key.
    address public owner;
    address public trustedSigner;

    mapping(bytes32 => address) public linkedWallet;
    mapping(bytes32 => uint256) public linkNonce;

    // ── v2 tip state ─────────────────────────────────────────────────────
    uint256 public nextTipId;
    mapping(uint256 => address) public tipperOf;
    mapping(uint256 => bool) public isPrivateTip;
    mapping(uint256 => bytes32) public privateCommitmentOf;
    mapping(uint256 => uint256) public tipMintedAt;
    mapping(uint256 => bytes32) public blobKeyCommitment;
    mapping(address => mapping(bytes32 => bool)) public usedPrivateCommitmentByTipper;
    bool private _reentrancyEntered;

    // ── EIP-712 ──────────────────────────────────────────────────────────
    bytes32 public constant LINK_TYPEHASH = keccak256(
        "Link(bytes32 providerHash,bytes32 handleHash,address recipient,uint256 nonce,uint256 deadline)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ── Events ───────────────────────────────────────────────────────────
    event Tip(
        uint256 indexed tipId,
        bytes32 indexed handleHash,
        address indexed from,
        uint256 amount,
        string displayHandle,
        string note
    );
    event PrivateTip(
        uint256 indexed tipId,
        bytes32 indexed handleHash,
        address indexed tipper,
        string displayHandle,
        bytes32 privateCommitment
    );
    event Pushed(bytes32 indexed handleHash, address indexed to, uint256 amount);
    event Linked(bytes32 indexed handleHash, address indexed wallet, string canonicalHandle);
    event Relinked(
        bytes32 indexed handleHash,
        address indexed oldWallet,
        address indexed newWallet,
        string canonicalHandle
    );
    event SignerRotated(address indexed oldSigner, address indexed newSigner);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────────
    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidVoucher();
    error VoucherExpired();
    error AlreadyLinked();
    error NotLinked();
    error RecipientNotLinked();
    error HandleHashMismatch();
    error HandleEmpty();
    error HandleTooLong();
    error UnsupportedHandle();
    error NoteTooLong();
    error TransferFailed();
    error AgentIdZero();
    error AgentWalletNotFound();
    error AgentWalletMismatch();
    error SelfTipNotAllowed();
    error InvalidPrivateCommitment();
    error DuplicateCommitment();
    error PermitFailedAndAllowanceInsufficient();
    error ReentrantCall();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyEntered) revert ReentrantCall();
        _reentrancyEntered = true;
        _;
        _reentrancyEntered = false;
    }

    constructor(
        address _usdc,
        address _boonToken,
        uint256 _privateTipBurn,
        uint256 _attestationBurn,
        uint256 _unlockPriceUsdc,
        address _identityRegistry,
        address _attestationContract,
        address _trustedSigner
    ) {
        if (
            _usdc == address(0) || _boonToken == address(0) || _identityRegistry == address(0)
                || _attestationContract == address(0) || _trustedSigner == address(0)
        ) revert ZeroAddress();
        if (_privateTipBurn == 0 || _attestationBurn == 0 || _unlockPriceUsdc == 0) {
            revert ZeroAmount();
        }

        USDC = _usdc;
        boonToken = _boonToken;
        PRIVATE_TIP_BURN = _privateTipBurn;
        ATTESTATION_BURN = _attestationBurn;
        UNLOCK_PRICE_USDC = _unlockPriceUsdc;
        identityRegistry = _identityRegistry;
        attestationContract = _attestationContract;
        owner = msg.sender;
        trustedSigner = _trustedSigner;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Boon")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    // ── Core: public handle tips ─────────────────────────────────────────
    function tip(
        string calldata handle,
        uint256 amount,
        string calldata note,
        bool mintAttestation,
        Permit calldata permit
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (bytes(note).length > MAX_NOTE_LEN) revert NoteTooLong();
        bytes32 handleHash = _validateSocialHandle(handle);
        address linked = linkedWallet[handleHash];

        if (linked == address(0)) revert RecipientNotLinked();
        if (linked == msg.sender) revert SelfTipNotAllowed();

        uint256 boonBurned = mintAttestation ? ATTESTATION_BURN : 0;
        uint256 tipId = _allocateTip(msg.sender);

        // CEI: persistent BoonV2 effects are recorded before external BOON,
        // USDC, and SBT calls. Any downstream failure reverts these writes.
        _burnBoon(boonBurned, permit);

        if (!IERC20V2(USDC).transferFrom(msg.sender, address(this), amount)) {
            revert TransferFailed();
        }

        emit Tip(tipId, handleHash, msg.sender, amount, handle, note);

        if (!IERC20V2(USDC).transfer(linked, amount)) revert TransferFailed();
        emit Pushed(handleHash, linked, amount);

        if (mintAttestation) {
            _mintAttestation(tipId, linked, handleHash, 0, bytes32(0), boonBurned);
        }
    }

    function tipAgent(
        uint256 agentId,
        address expectedWallet,
        uint256 amount,
        string calldata note,
        bool mintAttestation,
        Permit calldata permit
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (bytes(note).length > MAX_NOTE_LEN) revert NoteTooLong();
        AgentResolution memory agent = _resolveAgent(agentId);
        _checkExpectedAgentWallet(agent, expectedWallet);
        _checkAgentSelfTip(agent);

        uint256 boonBurned = mintAttestation ? ATTESTATION_BURN : 0;
        string memory handle = string.concat("agent:", _toString(agentId));
        bytes32 handleHash = keccak256(bytes(handle));
        uint256 tipId = _allocateTip(msg.sender);

        // CEI: allocate the tip before external token/SBT interactions.
        _burnBoon(boonBurned, permit);

        if (!IERC20V2(USDC).transferFrom(msg.sender, agent.payoutWallet, amount)) {
            revert TransferFailed();
        }

        emit Tip(tipId, handleHash, msg.sender, amount, handle, note);
        emit Pushed(handleHash, agent.payoutWallet, amount);

        if (mintAttestation) {
            _mintAttestation(tipId, agent.payoutWallet, handleHash, agentId, bytes32(0), boonBurned);
        }
    }

    function tipPrivate(
        bytes32 handleHash,
        string calldata displayHandle,
        address expectedWalletOrZero,
        uint256 amount,
        bytes32 privateCommitment,
        bool mintAttestation,
        Permit calldata permit
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (privateCommitment == bytes32(0)) revert InvalidPrivateCommitment();
        _validateHandleHash(handleHash, displayHandle);

        if (usedPrivateCommitmentByTipper[msg.sender][privateCommitment]) {
            revert DuplicateCommitment();
        }

        (address recipient, uint256 agentId) =
            _resolvePrivateRecipient(displayHandle, expectedWalletOrZero);
        if (recipient == msg.sender) revert SelfTipNotAllowed();

        uint256 boonBurned = PRIVATE_TIP_BURN + (mintAttestation ? ATTESTATION_BURN : 0);
        uint256 tipId = _allocateTip(msg.sender);
        isPrivateTip[tipId] = true;
        privateCommitmentOf[tipId] = privateCommitment;
        blobKeyCommitment[tipId] = privateCommitment;
        usedPrivateCommitmentByTipper[msg.sender][privateCommitment] = true;

        // CEI: dedup/tip/commitment state is set before BOON burn, USDC
        // settlement, and optional SBT mint. A revert rolls the effects back.
        _burnBoon(boonBurned, permit);

        if (!IERC20V2(USDC).transferFrom(msg.sender, recipient, amount)) revert TransferFailed();

        emit PrivateTip(tipId, handleHash, msg.sender, displayHandle, privateCommitment);
        // No Pushed-equivalent event is emitted for private tips: Pushed includes amount,
        // and re-emitting it here would undo the intended Boon event redaction.
        // Settlement is still auditable through token Transfer logs and the PrivateTip tipId.

        if (mintAttestation) {
            _mintAttestation(tipId, recipient, handleHash, agentId, privateCommitment, boonBurned);
        }
    }

    // ── Link handle ↔ wallet ─────────────────────────────────────────────
    function link(
        bytes32 handleHash,
        string calldata canonicalHandle,
        address recipient,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _link(handleHash, canonicalHandle, recipient, deadline, signature);
    }

    function relink(
        bytes32 handleHash,
        string calldata canonicalHandle,
        address newRecipient,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (newRecipient == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert VoucherExpired();
        _validateSocialHandleHash(handleHash, canonicalHandle);

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

    // ── Admin ────────────────────────────────────────────────────────────
    /// @notice Rotate the OAuth/social-link voucher signer.
    /// @dev Owner-only; does not alter existing links or tip flows.
    function rotateSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit SignerRotated(trustedSigner, newSigner);
        trustedSigner = newSigner;
    }

    /// @notice Transfer the narrow admin role to a new owner.
    /// @dev Production should use a Safe/multisig or timelock owner before public activation.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ── Internal helpers ─────────────────────────────────────────────────
    function _link(
        bytes32 handleHash,
        string calldata canonicalHandle,
        address recipient,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        if (recipient == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert VoucherExpired();
        _validateSocialHandleHash(handleHash, canonicalHandle);
        if (linkedWallet[handleHash] != address(0)) revert AlreadyLinked();

        bytes32 digest = _linkDigest(canonicalHandle, handleHash, recipient, deadline);
        if (_recover(digest, signature) != trustedSigner) revert InvalidVoucher();

        linkedWallet[handleHash] = recipient;
        unchecked {
            linkNonce[handleHash]++;
        }
        emit Linked(handleHash, recipient, canonicalHandle);
    }

    function _allocateTip(address tipper) internal returns (uint256 tipId) {
        tipId = nextTipId;
        unchecked {
            nextTipId = tipId + 1;
        }
        tipperOf[tipId] = tipper;
        tipMintedAt[tipId] = block.timestamp;
    }

    function _burnBoon(uint256 amount, Permit calldata permit) internal {
        if (amount == 0) return;

        bool permitOk = true;
        try IERC20PermitV2(boonToken)
            .permit(
                msg.sender, address(this), amount, permit.deadline, permit.v, permit.r, permit.s
            ) {}
        catch {
            permitOk = false;
        }

        if (!permitOk && IERC20V2(boonToken).allowance(msg.sender, address(this)) < amount) {
            revert PermitFailedAndAllowanceInsufficient();
        }
        if (!IERC20V2(boonToken).transferFrom(msg.sender, BOON_BURN_ADDRESS, amount)) {
            revert TransferFailed();
        }
    }

    function _mintAttestation(
        uint256 tipId,
        address recipient,
        bytes32 handleHash,
        uint256 agentId,
        bytes32 privateCommitment,
        uint256 boonBurnedTotal
    ) internal {
        IBoonGratitudeAttestation(attestationContract)
            .mint(tipId, recipient, handleHash, agentId, privateCommitment, boonBurnedTotal);
    }

    function _resolvePrivateRecipient(string calldata displayHandle, address expectedWalletOrZero)
        internal
        view
        returns (address recipient, uint256 agentId)
    {
        if (_isAgentHandle(displayHandle)) {
            agentId = _parseAgentHandle(displayHandle);
            AgentResolution memory agent = _resolveAgent(agentId);
            _checkExpectedAgentWallet(agent, expectedWalletOrZero);
            _checkAgentSelfTip(agent);
            return (agent.payoutWallet, agentId);
        }

        if (!_isSupportedSocialHandle(displayHandle)) revert UnsupportedHandle();
        recipient = linkedWallet[keccak256(bytes(displayHandle))];
        if (recipient == address(0)) revert RecipientNotLinked();
        if (expectedWalletOrZero == address(0) || expectedWalletOrZero != recipient) {
            revert AgentWalletMismatch();
        }
        return (recipient, 0);
    }

    function _resolveAgent(uint256 agentId) internal view returns (AgentResolution memory agent) {
        if (agentId == 0) revert AgentIdZero();

        try IIdentityRegistryV2(identityRegistry).getAgentWallet(agentId) returns (address wallet) {
            agent.agentWallet = wallet;
        } catch {}

        try IIdentityRegistryV2(identityRegistry).ownerOf(agentId) returns (address nftOwner) {
            agent.owner = nftOwner;
        } catch {}

        agent.payoutWallet = agent.agentWallet != address(0) ? agent.agentWallet : agent.owner;
        if (agent.payoutWallet == address(0)) revert AgentWalletNotFound();
    }

    function _checkExpectedAgentWallet(AgentResolution memory agent, address expectedWallet)
        internal
        pure
    {
        if (expectedWallet == address(0) || expectedWallet != agent.payoutWallet) {
            revert AgentWalletMismatch();
        }
    }

    function _checkAgentSelfTip(AgentResolution memory agent) internal view {
        if (
            msg.sender == agent.payoutWallet || msg.sender == agent.owner
                || (agent.agentWallet != address(0) && msg.sender == agent.agentWallet)
        ) revert SelfTipNotAllowed();
    }

    function _validateSocialHandle(string calldata displayHandle) internal pure returns (bytes32) {
        bytes32 handleHash = keccak256(bytes(displayHandle));
        _validateSocialHandleHash(handleHash, displayHandle);
        return handleHash;
    }

    function _validateSocialHandleHash(bytes32 handleHash, string calldata displayHandle)
        internal
        pure
    {
        uint256 len = bytes(displayHandle).length;
        if (len == 0) revert HandleEmpty();
        if (len > MAX_HANDLE_LEN) revert HandleTooLong();
        if (!_isSupportedSocialHandle(displayHandle)) revert UnsupportedHandle();
        if (keccak256(bytes(displayHandle)) != handleHash) revert HandleHashMismatch();
    }

    function _validateHandleHash(bytes32 handleHash, string calldata displayHandle) internal pure {
        uint256 len = bytes(displayHandle).length;
        if (len == 0) revert HandleEmpty();
        if (len > MAX_HANDLE_LEN) revert HandleTooLong();
        if (!_isSupportedHandle(displayHandle)) revert UnsupportedHandle();
        if (keccak256(bytes(displayHandle)) != handleHash) revert HandleHashMismatch();
    }

    function _isSupportedHandle(string calldata canonicalHandle) internal pure returns (bool) {
        return _isSupportedSocialHandle(canonicalHandle) || _isAgentHandle(canonicalHandle);
    }

    function _isSupportedSocialHandle(string calldata canonicalHandle)
        internal
        pure
        returns (bool)
    {
        bytes calldata b = bytes(canonicalHandle);
        if (b.length >= 3 && b[0] == "x" && b[1] == ":") return true;
        return (b.length >= 8 && b[0] == "g" && b[1] == "i" && b[2] == "t" && b[3] == "h"
                && b[4] == "u" && b[5] == "b" && b[6] == ":");
    }

    function _isAgentHandle(string calldata canonicalHandle) internal pure returns (bool) {
        bytes calldata b = bytes(canonicalHandle);
        return b.length > 6 && b[0] == "a" && b[1] == "g" && b[2] == "e" && b[3] == "n"
            && b[4] == "t" && b[5] == ":";
    }

    function _parseAgentHandle(string calldata canonicalHandle)
        internal
        pure
        returns (uint256 value)
    {
        bytes calldata b = bytes(canonicalHandle);
        if (!_isAgentHandle(canonicalHandle)) revert UnsupportedHandle();
        if (b[6] == "0") revert UnsupportedHandle();

        for (uint256 i = 6; i < b.length;) {
            uint8 digit = uint8(b[i]);
            if (digit < 48 || digit > 57) revert UnsupportedHandle();
            uint256 n = digit - 48;
            if (value > (type(uint256).max - n) / 10) revert UnsupportedHandle();
            value = value * 10 + n;
            unchecked {
                ++i;
            }
        }
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

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            unchecked {
                digits++;
                temp /= 10;
            }
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            unchecked {
                digits -= 1;
                buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
                value /= 10;
            }
        }
        return string(buffer);
    }
}
