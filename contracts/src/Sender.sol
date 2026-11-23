// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Subset of the XCM precompile interface (pallet-xcm-precompiles, IXcm.sol).
interface IXcm {
    function send(bytes calldata destination, bytes calldata message) external;
}

/// Lives on Para A. Sends an XCM message to another chain through the XCM
/// precompile. The message is SCALE-encoded off-chain and passed in as bytes.
/// On the destination, the message runs with this contract as its origin
/// (the precompile prepends DescendOrigin with the contract's account).
contract Sender {
    address constant XCM_PRECOMPILE = address(0xA0000);

    uint256 public sentCount;

    event MessageSent(address indexed caller, uint256 count, bytes destination, bytes message);

    /// Accept native tokens: the contract pays XCM delivery fees on Para A.
    receive() external payable {}

    function sendMessage(bytes calldata destination, bytes calldata message) external {
        IXcm(XCM_PRECOMPILE).send(destination, message);
        sentCount += 1;
        emit MessageSent(msg.sender, sentCount, destination, message);
    }
}
