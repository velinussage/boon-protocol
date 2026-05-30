// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * BoonGratitudeAttestationV3 — minimal ERC-721 + ERC-5192 soulbound proof.
 *
 * V3 keeps the no-OpenZeppelin pattern from the v2 attestation while replacing
 * the v2 one-shot forever-minter lock with a minter that can be rotated by a
 * multisig after a timelock. The initial minter is still initialized once by
 * the deploy owner during the v3 deployment ceremony.
 */
contract BoonGratitudeAttestationV3 {
    struct AttestationData {
        address recipient;
        bytes32 handleHash;
        uint256 mintedAt;
    }

    string public constant name = "Boon Gratitude Attestation";
    string public constant symbol = "BOON-SBT";

    address public owner;
    address public immutable multisig;
    uint256 public immutable timelockSeconds;

    address public minter;
    bool public minterInitialized;
    address public pendingMinter;
    uint256 public pendingMinterReadyAt;
    uint256 public nextMintableTipId = 1;
    mapping(address => bool) public authorizedMinters;

    string public metadataBaseURI;
    bool public metadataBaseURILocked;

    mapping(uint256 => AttestationData) public attestations;
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => bool) public tokenEverMinted;
    mapping(uint256 => address) public reservedMinterOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 indexed tokenId);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event MinterInitialized(address indexed minter);
    event MinterRotationScheduled(address indexed newMinter, uint256 readyAt);
    event MinterRotationExecuted(address indexed oldMinter, address indexed newMinter);
    event MinterRotationCancelled(address indexed pendingMinter);
    event AttestationMinted(
        uint256 indexed tipId, address indexed recipient, bytes32 indexed handleHash
    );
    event TipIdReserved(address indexed minter, uint256 indexed tipId);
    event AttestationBurned(uint256 indexed tipId, address indexed recipient);

    error NotOwner();
    error NotMultisig();
    error NotMinter();
    error ZeroAddress();
    error InvalidTimelock();
    error MinterAlreadyInitialized();
    error MinterNotInitialized();
    error NoPendingMinter();
    error TimelockNotReady();
    error TokenAlreadyMinted();
    error TokenNotMinted();
    error Soulbound();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMultisig() {
        if (msg.sender != multisig) revert NotMultisig();
        _;
    }

    constructor(address _initialOwner, address _multisig, uint256 _timelockSeconds) {
        if (_initialOwner == address(0) || _multisig == address(0)) revert ZeroAddress();
        if (_timelockSeconds == 0) revert InvalidTimelock();
        owner = _initialOwner;
        multisig = _multisig;
        timelockSeconds = _timelockSeconds;
        emit OwnershipTransferred(address(0), _initialOwner);
    }

    function initializeMinter(address _boonV3) external onlyOwner {
        if (_boonV3 == address(0)) revert ZeroAddress();
        if (minterInitialized || minter != address(0)) revert MinterAlreadyInitialized();
        minter = _boonV3;
        minterInitialized = true;
        authorizedMinters[_boonV3] = true;
        emit MinterInitialized(_boonV3);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function initializeMetadataBaseURI(string calldata baseURI) external onlyOwner {
        if (metadataBaseURILocked) revert MinterAlreadyInitialized();
        if (bytes(baseURI).length == 0) revert ZeroAddress();
        metadataBaseURI = baseURI;
        metadataBaseURILocked = true;
    }

    function scheduleMinterRotation(address newMinter) external onlyMultisig {
        if (!minterInitialized || minter == address(0)) revert MinterNotInitialized();
        if (newMinter == address(0)) revert ZeroAddress();
        pendingMinter = newMinter;
        pendingMinterReadyAt = block.timestamp + timelockSeconds;
        emit MinterRotationScheduled(newMinter, pendingMinterReadyAt);
    }

    function executeMinterRotation() external onlyMultisig {
        address newMinter = pendingMinter;
        if (newMinter == address(0)) revert NoPendingMinter();
        if (block.timestamp < pendingMinterReadyAt) revert TimelockNotReady();
        emit MinterRotationExecuted(minter, newMinter);
        minter = newMinter;
        authorizedMinters[newMinter] = true;
        pendingMinter = address(0);
        pendingMinterReadyAt = 0;
    }

    function cancelMinterRotation() external onlyMultisig {
        address cancelled = pendingMinter;
        if (cancelled == address(0)) revert NoPendingMinter();
        pendingMinter = address(0);
        pendingMinterReadyAt = 0;
        emit MinterRotationCancelled(cancelled);
    }

    function mint(address recipient, uint256 tipId, bytes32 handleHash) external {
        if (!authorizedMinters[msg.sender]) revert NotMinter();
        if (recipient == address(0)) revert ZeroAddress();
        if (tokenEverMinted[tipId]) revert TokenAlreadyMinted();
        address reservedMinter = reservedMinterOf[tipId];
        if (reservedMinter != address(0) && reservedMinter != msg.sender) {
            revert TokenAlreadyMinted();
        }

        tokenEverMinted[tipId] = true;
        delete reservedMinterOf[tipId];
        ownerOf[tipId] = recipient;
        unchecked {
            balanceOf[recipient] += 1;
            if (tipId >= nextMintableTipId) nextMintableTipId = tipId + 1;
        }
        attestations[tipId] = AttestationData({
            recipient: recipient, handleHash: handleHash, mintedAt: block.timestamp
        });

        emit Transfer(address(0), recipient, tipId);
        emit Locked(tipId);
        emit AttestationMinted(tipId, recipient, handleHash);
    }

    function reserveTipId(uint256 tipId) external {
        if (!authorizedMinters[msg.sender]) revert NotMinter();
        if (tokenEverMinted[tipId]) revert TokenAlreadyMinted();
        address reservedMinter = reservedMinterOf[tipId];
        if (reservedMinter != address(0) && reservedMinter != msg.sender) {
            revert TokenAlreadyMinted();
        }
        reservedMinterOf[tipId] = msg.sender;
        unchecked {
            if (tipId >= nextMintableTipId) nextMintableTipId = tipId + 1;
        }
        emit TipIdReserved(msg.sender, tipId);
    }

    function burn(uint256 tokenId) external {
        address recipient = ownerOf[tokenId];
        if (recipient == address(0)) revert TokenNotMinted();
        if (msg.sender != recipient) revert Soulbound();

        delete ownerOf[tokenId];
        delete attestations[tokenId];
        unchecked {
            balanceOf[recipient] -= 1;
        }

        emit AttestationBurned(tokenId, recipient);
        emit Transfer(recipient, address(0), tokenId);
    }

    function locked(uint256 tokenId) external view returns (bool) {
        _requireMinted(tokenId);
        return true;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        _requireMinted(tokenId);
        if (bytes(metadataBaseURI).length > 0) {
            return string.concat(metadataBaseURI, _toString(tokenId));
        }
        return string.concat(
            "data:application/json,",
            "{\"name\":\"Boon Gratitude Attestation #",
            _toString(tokenId),
            "\",\"description\":\"Soulbound proof of a funded Boon gratitude tip.\",",
            "\"image\":\"https://boonprotocol.com/attestation-og-image.png\",",
            "\"external_url\":\"https://boonprotocol.com\"}"
        );
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 Metadata extension
            || interfaceId == 0xb45a3c0e; // ERC-5192
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        _requireMinted(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function _requireMinted(uint256 tokenId) internal view {
        if (ownerOf[tokenId] == address(0)) revert TokenNotMinted();
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
