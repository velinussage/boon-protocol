// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20V3 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IERC20PermitV3 {
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

interface IIdentityRegistryV3 {
    function getAgentWallet(uint256 agentId) external view returns (address);
    function ownerOf(uint256 agentId) external view returns (address);
}

interface IBoonGratitudeAttestationV3 {
    function mint(address recipient, uint256 tipId, bytes32 handleHash) external;
    function reserveTipId(uint256 tipId) external;
    function nextMintableTipId() external view returns (uint256);
}

contract BoonV3 {
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

    struct EscrowEntry {
        address tipper;
        uint256 usdcAmount;
        bytes32 privateCommitment;
        bytes32 noteHash;
        uint64 createdAt;
        uint128 boonBurned;
        bool mintAttestation;
        bool claimed;
        uint256 nextTipId;
        bytes32 handleHash;
    }

    uint256 public constant MAX_HANDLE_LEN = 90;
    uint256 public constant MAX_NOTE_LEN = 280;
    uint256 public constant MAX_ESCROW_PER_HANDLE = 256;
    uint256 public constant MIN_ESCROW_USDC = 100_000;
    uint256 public constant DEFAULT_CLAIM_LIMIT = 32;
    uint256 public constant ESCROW_REFUND_DELAY = 180 days;
    address public constant BOON_BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public immutable USDC;
    address public immutable BOON;
    address public immutable IDENTITY_REGISTRY;
    address public immutable ATTESTATION_CONTRACT;
    uint256 public immutable PRIVATE_TIP_BURN;
    uint256 public immutable ATTESTATION_BURN;
    uint256 public immutable UNLOCK_PRICE_USDC;

    address public owner;
    address public trustedSigner;
    address public escrowGuardian;
    bool public paused;
    bool private _reentrancyEntered;

    uint256 public nextTipId;
    mapping(uint256 => EscrowEntry) public escrowEntries;
    mapping(bytes32 => uint256) public firstEscrowedTipId;
    mapping(bytes32 => uint256) public lastEscrowedTipId;
    mapping(bytes32 => uint256) public escrowCount;
    mapping(bytes32 => address) public linkedWallet;
    mapping(bytes32 => address) public firstClaimWallet;
    mapping(uint256 => address) public tipperOf;
    mapping(uint256 => uint256) public tipMintedAt;
    mapping(uint256 => bytes32) public blobKeyCommitment;
    mapping(address => mapping(bytes32 => bool)) public usedPrivateCommitmentByTipper;
    mapping(bytes32 => uint256) public nonces;

    bytes32 public constant LINK_TYPEHASH =
        keccak256("Link(bytes32 handleHash,address recipient,uint256 nonce)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    event Tip(
        uint256 indexed tipId,
        bytes32 indexed handleHash,
        address indexed tipper,
        address recipient,
        string displayHandle,
        string note,
        uint256 usdcAmount,
        bool mintAttestation
    );
    event TipAgent(
        uint256 indexed tipId,
        uint256 indexed agentId,
        address indexed tipper,
        address resolvedAgentWallet,
        string note,
        uint256 usdcAmount,
        bool mintAttestation
    );
    event PrivateTip(
        uint256 indexed tipId,
        bytes32 indexed handleHash,
        address indexed tipper,
        string displayHandle,
        bytes32 privateCommitment
    );
    event TipEscrowed(
        uint256 indexed tipId,
        bytes32 indexed handleHash,
        address indexed tipper,
        string displayHandle,
        string note,
        uint256 usdcAmount,
        bool mintAttestation
    );
    event PrivateTipEscrowed(
        uint256 indexed tipId,
        bytes32 indexed handleHash,
        address indexed tipper,
        string displayHandle,
        bytes32 privateCommitment,
        bool mintAttestation
    );
    event EscrowedClaimed(
        uint256 indexed tipId,
        bytes32 indexed handleHash,
        address indexed recipient,
        uint256 usdcAmount
    );
    event EscrowedRefunded(
        uint256 indexed tipId,
        bytes32 indexed handleHash,
        address indexed tipper,
        uint256 usdcAmount
    );
    event DeferredAttestationMinted(
        uint256 indexed tipId, address indexed recipient, bytes32 indexed handleHash
    );
    event Linked(bytes32 indexed handleHash, address indexed wallet);
    event Relinked(
        bytes32 indexed handleHash, address indexed oldWallet, address indexed newWallet
    );
    event EscrowGuardianRotated(address indexed oldGuardian, address indexed newGuardian);
    event TrustedSignerRotated(address indexed oldSigner, address indexed newSigner);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error TokenAddressCollision();
    error InvalidVoucher();
    error BadNonce();
    error AlreadyLinked();
    error NotLinked();
    error RecipientNotLinked();
    error HandleHashMismatch();
    error HandleEmpty();
    error HandleTooLong();
    error NoteTooLong();
    error UnsupportedHandle();
    error TransferFailed();
    error AgentIdZero();
    error RecipientNotResolvable();
    error AgentWalletNotFound();
    error RecipientWalletMismatch();
    error SelfTipNotAllowed();
    error InvalidPrivateCommitment();
    error DuplicateCommitment();
    error PermitFailedAndAllowanceInsufficient();
    error ReentrantCall();
    error PausedError();
    error EscrowCapExceeded();
    error AmountTooLow();
    error NoEscrow();
    error RefundDelayNotMet();
    error NotTipper();
    error AlreadyClaimed();
    error NoClaimSettled();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
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
        address _boon,
        address _identityRegistry,
        address _attestationContract,
        address _trustedSigner,
        uint256 _privateTipBurn,
        uint256 _attestationBurn,
        uint256 _unlockPriceUsdc,
        address _escrowGuardian
    ) {
        if (
            _usdc == address(0) || _boon == address(0) || _identityRegistry == address(0)
                || _attestationContract == address(0) || _trustedSigner == address(0)
                || _escrowGuardian == address(0)
        ) revert ZeroAddress();
        if (_usdc == _boon) revert TokenAddressCollision();
        if (_privateTipBurn == 0 || _attestationBurn == 0 || _unlockPriceUsdc == 0) {
            revert ZeroAmount();
        }

        USDC = _usdc;
        BOON = _boon;
        IDENTITY_REGISTRY = _identityRegistry;
        ATTESTATION_CONTRACT = _attestationContract;
        trustedSigner = _trustedSigner;
        PRIVATE_TIP_BURN = _privateTipBurn;
        ATTESTATION_BURN = _attestationBurn;
        UNLOCK_PRICE_USDC = _unlockPriceUsdc;
        escrowGuardian = _escrowGuardian;
        owner = msg.sender;
        uint256 initialTipId = 1;
        try IBoonGratitudeAttestationV3(_attestationContract).nextMintableTipId() returns (
            uint256 syncedTipId
        ) {
            if (syncedTipId != 0) initialTipId = syncedTipId;
        } catch {}
        nextTipId = initialTipId;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Boon")),
                keccak256(bytes("3")),
                block.chainid,
                address(this)
            )
        );
        emit OwnerTransferred(address(0), msg.sender);
    }

    function tip(
        bytes32 handleHash,
        string calldata displayHandle,
        address expectedWalletOrZero,
        uint256 amount,
        string calldata note,
        bool mintAttestation,
        Permit calldata permit
    ) external nonReentrant whenNotPaused returns (uint256 tipId) {
        if (amount == 0) revert ZeroAmount();
        _validateNote(note);
        _validateSocialHandleHash(handleHash, displayHandle);
        address linked = linkedWallet[handleHash];
        if (expectedWalletOrZero != address(0) && expectedWalletOrZero != linked) {
            revert RecipientWalletMismatch();
        }

        tipId = _allocateTip(msg.sender, mintAttestation);
        _burnBoon(mintAttestation ? ATTESTATION_BURN : 0, permit);

        if (linked == address(0)) {
            _settleEscrowedPublicTip(
                tipId, handleHash, amount, displayHandle, note, mintAttestation
            );
        } else {
            _settleLinkedPublicTip(
                tipId, handleHash, linked, amount, displayHandle, note, mintAttestation
            );
        }
    }

    function _settleEscrowedPublicTip(
        uint256 tipId,
        bytes32 handleHash,
        uint256 amount,
        string calldata displayHandle,
        string calldata note,
        bool mintAttestation
    ) internal {
        uint256 boonBurned = mintAttestation ? ATTESTATION_BURN : 0;
        _pullUsdcToContract(msg.sender, amount);
        _addEscrowEntry(
            tipId,
            handleHash,
            msg.sender,
            amount,
            bytes32(0),
            keccak256(bytes(note)),
            boonBurned,
            mintAttestation
        );
        emit TipEscrowed(
            tipId, handleHash, msg.sender, displayHandle, note, amount, mintAttestation
        );
    }

    function _settleLinkedPublicTip(
        uint256 tipId,
        bytes32 handleHash,
        address recipient,
        uint256 amount,
        string calldata displayHandle,
        string calldata note,
        bool mintAttestation
    ) internal {
        if (recipient == msg.sender) revert SelfTipNotAllowed();
        _transferUsdcFrom(msg.sender, recipient, amount);
        emit Tip(
            tipId, handleHash, msg.sender, recipient, displayHandle, note, amount, mintAttestation
        );
        if (mintAttestation) _mintAttestation(tipId, recipient, handleHash);
    }

    function tipAgent(
        uint256 agentId,
        address expectedWallet,
        uint256 amount,
        string calldata note,
        bool mintAttestation,
        Permit calldata permit
    ) external nonReentrant whenNotPaused returns (uint256 tipId) {
        if (amount == 0) revert ZeroAmount();
        _validateNote(note);
        AgentResolution memory agent = _resolveAgent(agentId);
        _checkExpectedWallet(agent, expectedWallet);
        _checkAgentSelfTip(agent);

        uint256 boonBurned = mintAttestation ? ATTESTATION_BURN : 0;
        tipId = _allocateTip(msg.sender, mintAttestation);
        _burnBoon(boonBurned, permit);
        _transferUsdcFrom(msg.sender, agent.payoutWallet, amount);
        emit TipAgent(tipId, agentId, msg.sender, agent.payoutWallet, note, amount, mintAttestation);
        if (mintAttestation) {
            _mintAttestation(
                tipId,
                agent.payoutWallet,
                keccak256(bytes(string.concat("agent:", _toString(agentId))))
            );
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
    ) external nonReentrant whenNotPaused returns (uint256 tipId) {
        if (amount == 0) revert ZeroAmount();
        if (privateCommitment == bytes32(0)) revert InvalidPrivateCommitment();
        _validateSocialHandleHash(handleHash, displayHandle);
        if (usedPrivateCommitmentByTipper[msg.sender][privateCommitment]) {
            revert DuplicateCommitment();
        }

        address linked = linkedWallet[handleHash];
        if (expectedWalletOrZero != address(0) && expectedWalletOrZero != linked) {
            revert RecipientWalletMismatch();
        }

        uint256 boonBurned = PRIVATE_TIP_BURN + (mintAttestation ? ATTESTATION_BURN : 0);
        tipId = _allocateTip(msg.sender, mintAttestation);
        blobKeyCommitment[tipId] = privateCommitment;
        usedPrivateCommitmentByTipper[msg.sender][privateCommitment] = true;
        _burnBoon(boonBurned, permit);

        if (linked == address(0)) {
            _pullUsdcToContract(msg.sender, amount);
            _addEscrowEntry(
                tipId,
                handleHash,
                msg.sender,
                amount,
                privateCommitment,
                bytes32(0),
                boonBurned,
                mintAttestation
            );
            emit PrivateTipEscrowed(
                tipId, handleHash, msg.sender, displayHandle, privateCommitment, mintAttestation
            );
        } else {
            if (linked == msg.sender) revert SelfTipNotAllowed();
            _transferUsdcFrom(msg.sender, linked, amount);
            emit PrivateTip(tipId, handleHash, msg.sender, displayHandle, privateCommitment);
            if (mintAttestation) _mintAttestation(tipId, linked, handleHash);
        }
    }

    function tipPrivateAgent(
        uint256 agentId,
        address expectedWallet,
        uint256 amount,
        bytes32 privateCommitment,
        bool mintAttestation,
        Permit calldata permit
    ) external nonReentrant whenNotPaused returns (uint256 tipId) {
        if (amount == 0) revert ZeroAmount();
        if (privateCommitment == bytes32(0)) revert InvalidPrivateCommitment();
        if (usedPrivateCommitmentByTipper[msg.sender][privateCommitment]) {
            revert DuplicateCommitment();
        }
        AgentResolution memory agent = _resolveAgent(agentId);
        _checkExpectedWallet(agent, expectedWallet);
        _checkAgentSelfTip(agent);

        uint256 boonBurned = PRIVATE_TIP_BURN + (mintAttestation ? ATTESTATION_BURN : 0);
        bytes32 handleHash = keccak256(bytes(string.concat("agent:", _toString(agentId))));
        tipId = _allocateTip(msg.sender, mintAttestation);
        blobKeyCommitment[tipId] = privateCommitment;
        usedPrivateCommitmentByTipper[msg.sender][privateCommitment] = true;
        _burnBoon(boonBurned, permit);
        _transferUsdcFrom(msg.sender, agent.payoutWallet, amount);
        emit PrivateTip(
            tipId,
            handleHash,
            msg.sender,
            string.concat("agent:", _toString(agentId)),
            privateCommitment
        );
        if (mintAttestation) _mintAttestation(tipId, agent.payoutWallet, handleHash);
    }

    function link(bytes32 handleHash, address recipient, uint256 nonce, bytes calldata workerSig)
        external
        whenNotPaused
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (firstEscrowedTipId[handleHash] != 0) revert NoEscrow();
        if (linkedWallet[handleHash] != address(0)) revert AlreadyLinked();
        _verifyWorker(handleHash, recipient, nonce, workerSig);
        linkedWallet[handleHash] = recipient;
        if (firstClaimWallet[handleHash] == address(0)) firstClaimWallet[handleHash] = recipient;
        unchecked {
            nonces[handleHash] = nonce + 1;
        }
        emit Linked(handleHash, recipient);
    }

    function linkEscrowed(
        bytes32 handleHash,
        address recipient,
        uint256 nonce,
        bytes calldata workerSig,
        bytes calldata guardianSig
    ) external whenNotPaused {
        if (recipient == address(0)) revert ZeroAddress();
        if (firstEscrowedTipId[handleHash] == 0) revert NoEscrow();
        if (linkedWallet[handleHash] != address(0)) revert AlreadyLinked();
        _verifyWorker(handleHash, recipient, nonce, workerSig);
        _verifyGuardian(handleHash, recipient, nonce, guardianSig);
        linkedWallet[handleHash] = recipient;
        if (firstClaimWallet[handleHash] == address(0)) firstClaimWallet[handleHash] = recipient;
        unchecked {
            nonces[handleHash] = nonce + 1;
        }
        emit Linked(handleHash, recipient);
    }

    function linkAndClaim(
        bytes32 handleHash,
        address recipient,
        uint256 nonce,
        bytes calldata workerSig,
        bytes calldata guardianSig,
        uint256 maxItems
    ) external nonReentrant whenNotPaused {
        if (recipient == address(0)) revert ZeroAddress();
        if (firstEscrowedTipId[handleHash] == 0) revert NoEscrow();
        if (linkedWallet[handleHash] != address(0)) revert AlreadyLinked();
        _verifyWorker(handleHash, recipient, nonce, workerSig);
        _verifyGuardian(handleHash, recipient, nonce, guardianSig);
        linkedWallet[handleHash] = recipient;
        if (firstClaimWallet[handleHash] == address(0)) firstClaimWallet[handleHash] = recipient;
        unchecked {
            nonces[handleHash] = nonce + 1;
        }
        emit Linked(handleHash, recipient);
        _claimHead(handleHash, maxItems);
    }

    function relink(
        bytes32 handleHash,
        address newRecipient,
        uint256 nonce,
        bytes calldata workerSig
    ) external whenNotPaused {
        if (newRecipient == address(0)) revert ZeroAddress();
        address oldRecipient = linkedWallet[handleHash];
        if (oldRecipient == address(0)) revert NotLinked();
        _verifyWorker(handleHash, newRecipient, nonce, workerSig);
        linkedWallet[handleHash] = newRecipient;
        unchecked {
            nonces[handleHash] = nonce + 1;
        }
        emit Relinked(handleHash, oldRecipient, newRecipient);
    }

    function claim(bytes32 handleHash, uint256 maxItems) external nonReentrant whenNotPaused {
        _claimHead(handleHash, maxItems);
    }

    function claimSpecific(uint256[] calldata tipIds) external nonReentrant whenNotPaused {
        uint256 settled;
        for (uint256 i; i < tipIds.length;) {
            uint256 tipId = tipIds[i];
            EscrowEntry storage entry = escrowEntries[tipId];
            if (entry.tipper != address(0) && !entry.claimed) {
                address recipient = firstClaimWallet[entry.handleHash];
                if (recipient == address(0)) revert RecipientNotLinked();
                _unlinkEscrowEntry(entry.handleHash, tipId);
                _settleEscrowEntry(tipId, recipient);
                unchecked {
                    ++settled;
                }
            }
            unchecked {
                ++i;
            }
        }
        if (settled == 0) revert NoClaimSettled();
    }

    function refund(uint256 tipId) external nonReentrant {
        EscrowEntry storage entry = escrowEntries[tipId];
        if (entry.tipper == address(0)) revert NoEscrow();
        if (entry.claimed) revert AlreadyClaimed();
        if (entry.tipper != msg.sender) revert NotTipper();
        if (firstClaimWallet[entry.handleHash] != address(0)) revert AlreadyLinked();
        if (block.timestamp < uint256(entry.createdAt) + ESCROW_REFUND_DELAY) {
            revert RefundDelayNotMet();
        }

        uint256 amount = entry.usdcAmount;
        bytes32 handleHash = entry.handleHash;
        _unlinkEscrowEntry(handleHash, tipId);
        entry.claimed = true;
        if (!IERC20V3(USDC).transfer(msg.sender, amount)) revert TransferFailed();
        emit EscrowedRefunded(tipId, handleHash, msg.sender, amount);
    }

    function rotateEscrowGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit EscrowGuardianRotated(escrowGuardian, newGuardian);
        escrowGuardian = newGuardian;
    }

    function setTrustedSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit TrustedSignerRotated(trustedSigner, newSigner);
        trustedSigner = newSigner;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function getEscrowEntry(uint256 tipId) external view returns (EscrowEntry memory) {
        return escrowEntries[tipId];
    }

    function getEscrowCount(bytes32 handleHash) external view returns (uint256) {
        return escrowCount[handleHash];
    }

    function getEscrowedTipIds(bytes32 handleHash, uint256 maxItems)
        external
        view
        returns (uint256[] memory ids)
    {
        uint256 count = escrowCount[handleHash];
        uint256 limit = maxItems == 0 || maxItems > count ? count : maxItems;
        ids = new uint256[](limit);
        uint256 tipId = firstEscrowedTipId[handleHash];
        for (uint256 i; i < limit && tipId != 0;) {
            ids[i] = tipId;
            tipId = escrowEntries[tipId].nextTipId;
            unchecked {
                ++i;
            }
        }
    }

    function _claimHead(bytes32 handleHash, uint256 maxItems) internal {
        address recipient = firstClaimWallet[handleHash];
        if (recipient == address(0)) revert RecipientNotLinked();
        uint256 limit = maxItems == 0 ? DEFAULT_CLAIM_LIMIT : maxItems;
        uint256 tipId = firstEscrowedTipId[handleHash];
        uint256 processed;
        while (tipId != 0 && processed < limit) {
            uint256 next = escrowEntries[tipId].nextTipId;
            firstEscrowedTipId[handleHash] = next;
            if (next == 0) lastEscrowedTipId[handleHash] = 0;
            escrowEntries[tipId].nextTipId = 0;
            unchecked {
                escrowCount[handleHash] -= 1;
                ++processed;
            }
            _settleEscrowEntry(tipId, recipient);
            tipId = next;
        }
    }

    function _settleEscrowEntry(uint256 tipId, address recipient) internal {
        EscrowEntry storage entry = escrowEntries[tipId];
        if (entry.claimed) revert AlreadyClaimed();
        entry.claimed = true;
        uint256 amount = entry.usdcAmount;
        bytes32 handleHash = entry.handleHash;
        if (!IERC20V3(USDC).transfer(recipient, amount)) revert TransferFailed();
        emit EscrowedClaimed(tipId, handleHash, recipient, amount);
        if (entry.mintAttestation) _mintAttestation(tipId, recipient, handleHash);
    }

    function _unlinkEscrowEntry(bytes32 handleHash, uint256 tipId) internal {
        uint256 head = firstEscrowedTipId[handleHash];
        if (head == 0) return;
        if (head == tipId) {
            uint256 next = escrowEntries[tipId].nextTipId;
            firstEscrowedTipId[handleHash] = next;
            if (lastEscrowedTipId[handleHash] == tipId) lastEscrowedTipId[handleHash] = next;
            escrowEntries[tipId].nextTipId = 0;
            unchecked {
                escrowCount[handleHash] -= 1;
            }
            return;
        }
        uint256 prev = head;
        uint256 current = escrowEntries[prev].nextTipId;
        while (current != 0) {
            if (current == tipId) {
                uint256 next = escrowEntries[current].nextTipId;
                escrowEntries[prev].nextTipId = next;
                if (lastEscrowedTipId[handleHash] == current) lastEscrowedTipId[handleHash] = prev;
                escrowEntries[current].nextTipId = 0;
                unchecked {
                    escrowCount[handleHash] -= 1;
                }
                return;
            }
            prev = current;
            current = escrowEntries[current].nextTipId;
        }
    }

    function _addEscrowEntry(
        uint256 tipId,
        bytes32 handleHash,
        address tipper,
        uint256 amount,
        bytes32 privateCommitment,
        bytes32 noteHash,
        uint256 boonBurned,
        bool mintAttestation
    ) internal {
        if (amount < MIN_ESCROW_USDC) revert AmountTooLow();
        if (escrowCount[handleHash] >= MAX_ESCROW_PER_HANDLE) revert EscrowCapExceeded();
        escrowEntries[tipId] = EscrowEntry({
            tipper: tipper,
            usdcAmount: amount,
            privateCommitment: privateCommitment,
            noteHash: noteHash,
            createdAt: uint64(block.timestamp),
            boonBurned: uint128(boonBurned),
            mintAttestation: mintAttestation,
            claimed: false,
            nextTipId: 0,
            handleHash: handleHash
        });
        uint256 tail = lastEscrowedTipId[handleHash];
        if (tail == 0) {
            firstEscrowedTipId[handleHash] = tipId;
        } else {
            escrowEntries[tail].nextTipId = tipId;
        }
        lastEscrowedTipId[handleHash] = tipId;
        unchecked {
            escrowCount[handleHash] += 1;
        }
    }

    function _allocateTip(address tipper, bool mintAttestation) internal returns (uint256 tipId) {
        if (mintAttestation) _syncNextTipIdFromAttestation();
        tipId = nextTipId;
        unchecked {
            nextTipId = tipId + 1;
        }
        tipperOf[tipId] = tipper;
        tipMintedAt[tipId] = block.timestamp;
        if (mintAttestation) _reserveAttestationTipId(tipId);
    }

    function _burnBoon(uint256 amount, Permit calldata permit) internal {
        if (amount == 0) return;
        bool permitOk = true;
        try IERC20PermitV3(BOON)
            .permit(
                msg.sender, address(this), amount, permit.deadline, permit.v, permit.r, permit.s
            ) {}
        catch {
            permitOk = false;
        }
        if (!permitOk && IERC20V3(BOON).allowance(msg.sender, address(this)) < amount) {
            revert PermitFailedAndAllowanceInsufficient();
        }
        if (!IERC20V3(BOON).transferFrom(msg.sender, BOON_BURN_ADDRESS, amount)) {
            revert TransferFailed();
        }
    }

    function _pullUsdcToContract(address from, uint256 amount) internal {
        _transferUsdcFrom(from, address(this), amount);
    }

    function _transferUsdcFrom(address from, address to, uint256 amount) internal {
        if (!IERC20V3(USDC).transferFrom(from, to, amount)) revert TransferFailed();
    }

    function _mintAttestation(uint256 tipId, address recipient, bytes32 handleHash) internal {
        IBoonGratitudeAttestationV3(ATTESTATION_CONTRACT).mint(recipient, tipId, handleHash);
        emit DeferredAttestationMinted(tipId, recipient, handleHash);
    }

    function _reserveAttestationTipId(uint256 tipId) internal {
        IBoonGratitudeAttestationV3(ATTESTATION_CONTRACT).reserveTipId(tipId);
    }

    function _syncNextTipIdFromAttestation() internal {
        try IBoonGratitudeAttestationV3(ATTESTATION_CONTRACT).nextMintableTipId() returns (
            uint256 syncedTipId
        ) {
            if (syncedTipId > nextTipId) nextTipId = syncedTipId;
        } catch {}
    }

    function _verifyWorker(
        bytes32 handleHash,
        address recipient,
        uint256 nonce,
        bytes calldata signature
    ) internal view {
        if (nonce != nonces[handleHash]) revert BadNonce();
        if (_recover(_linkDigest(handleHash, recipient, nonce), signature) != trustedSigner) {
            revert InvalidVoucher();
        }
    }

    function _verifyGuardian(
        bytes32 handleHash,
        address recipient,
        uint256 nonce,
        bytes calldata signature
    ) internal view {
        if (_recover(_linkDigest(handleHash, recipient, nonce), signature) != escrowGuardian) revert InvalidVoucher();
    }

    function _linkDigest(bytes32 handleHash, address recipient, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(LINK_TYPEHASH, handleHash, recipient, nonce));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _resolveAgent(uint256 agentId) internal view returns (AgentResolution memory agent) {
        if (agentId == 0) revert AgentIdZero();
        bool ownerResolved;
        try IIdentityRegistryV3(IDENTITY_REGISTRY).ownerOf(agentId) returns (address nftOwner) {
            if (nftOwner != address(0)) {
                agent.owner = nftOwner;
                ownerResolved = true;
            }
        } catch {}
        if (!ownerResolved) revert RecipientNotResolvable();
        try IIdentityRegistryV3(IDENTITY_REGISTRY).getAgentWallet(agentId) returns (
            address wallet
        ) {
            agent.agentWallet = wallet;
        } catch {}
        agent.payoutWallet = agent.agentWallet != address(0) ? agent.agentWallet : agent.owner;
        if (agent.payoutWallet == address(0)) revert AgentWalletNotFound();
    }

    function _checkExpectedWallet(AgentResolution memory agent, address expectedWallet)
        internal
        pure
    {
        if (expectedWallet == address(0) || expectedWallet != agent.payoutWallet) {
            revert RecipientWalletMismatch();
        }
    }

    function _checkAgentSelfTip(AgentResolution memory agent) internal view {
        if (
            msg.sender == agent.payoutWallet || msg.sender == agent.owner
                || (agent.agentWallet != address(0) && msg.sender == agent.agentWallet)
        ) revert SelfTipNotAllowed();
    }

    function _validateNote(string calldata note) internal pure {
        if (bytes(note).length > MAX_NOTE_LEN) revert NoteTooLong();
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

    function _isSupportedSocialHandle(string calldata canonicalHandle)
        internal
        pure
        returns (bool)
    {
        bytes calldata b = bytes(canonicalHandle);
        if (b.length >= 3 && b[0] == "x" && b[1] == ":") return true;
        return b.length >= 8 && b[0] == "g" && b[1] == "i" && b[2] == "t" && b[3] == "h"
            && b[4] == "u" && b[5] == "b" && b[6] == ":";
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
                ++digits;
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
